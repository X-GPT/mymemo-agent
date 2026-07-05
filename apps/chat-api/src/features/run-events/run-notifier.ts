import { type Client, Client as PgClient } from "pg";

/**
 * A live wake-up for one run's SSE projector. `LISTEN/NOTIFY` is *only* a
 * latency optimization: the projector re-reads the durable `run_events` table
 * on every loop turn, so a lost or never-delivered wake-up costs latency (one
 * poll interval) but never an event. Wake-ups that land between waits are
 * coalesced into a single pending signal, so a notify that arrives while the
 * projector is reading or streaming is not dropped.
 */
export interface RunSubscription {
	/** Resolve when a wake-up for this run arrives, or after `timeoutMs`. */
	waitForWakeup(timeoutMs: number): Promise<void>;
	/** Stop listening for this run. Idempotent. */
	close(): Promise<void>;
}

export interface RunNotifier {
	subscribe(runId: string): Promise<RunSubscription>;
}

/** The single channel every appender notifies on; the payload carries the run id. */
export const RUN_EVENTS_CHANNEL = "run_events";

/**
 * Extract a run id from a `run_events` notification payload. Malformed payloads
 * yield `null` and are ignored — a bad notify can only cost a wake-up, never
 * deliver a wrong one.
 */
export function parseRunNotification(
	payload: string | undefined,
): string | null {
	if (!payload) return null;
	try {
		const parsed: unknown = JSON.parse(payload);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { runId?: unknown }).runId === "string"
		) {
			return (parsed as { runId: string }).runId;
		}
	} catch {
		// not JSON — ignore
	}
	return null;
}

interface Waiter {
	/** True when a signal arrived while no `waitForWakeup` was outstanding. */
	pending: boolean;
	/** Resolver of the currently outstanding wait, if any. */
	wake: (() => void) | null;
}

/**
 * In-memory registry of per-run waiters. The transport (Postgres LISTEN, or a
 * test) calls {@link signal} when a run advances; each subscription waits on its
 * own coalescing latch. Pure and deterministic — this is where the wake-up
 * semantics are tested, without a database.
 *
 * A run can have several concurrent subscriptions on purpose: the reconnect
 * endpoint (plan Task 2.3) lets a second client tail a run while the original
 * `user.message` stream is still open, and both must wake on each append.
 */
export class RunWakeupRegistry {
	private readonly waiters = new Map<string, Set<Waiter>>();

	subscribe(runId: string): RunSubscription {
		const waiter: Waiter = { pending: false, wake: null };
		const set = this.waiters.get(runId) ?? new Set<Waiter>();
		set.add(waiter);
		this.waiters.set(runId, set);

		return {
			waitForWakeup: (timeoutMs: number) =>
				new Promise<void>((resolve) => {
					if (waiter.pending) {
						waiter.pending = false;
						resolve();
						return;
					}
					let settled = false;
					const finish = () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						waiter.wake = null;
						resolve();
					};
					const timer = setTimeout(finish, timeoutMs);
					waiter.wake = () => {
						waiter.pending = false;
						finish();
					};
				}),
			close: async () => {
				const s = this.waiters.get(runId);
				if (!s) return;
				s.delete(waiter);
				if (s.size === 0) this.waiters.delete(runId);
			},
		};
	}

	/** Wake every subscription for `runId`, coalescing if none is waiting. */
	signal(runId: string): void {
		const set = this.waiters.get(runId);
		if (!set) return;
		for (const waiter of set) {
			if (waiter.wake) waiter.wake();
			else waiter.pending = true;
		}
	}
}

/**
 * Postgres `LISTEN/NOTIFY` notifier. Owns one dedicated `pg` connection (never a
 * pooled/PgBouncer-multiplexed one — a listener must stay pinned to its backend)
 * that `LISTEN`s on {@link RUN_EVENTS_CHANNEL} and fans each notification to the
 * matching run's waiters via a {@link RunWakeupRegistry}. Every SSE stream in
 * the process shares this one listener connection.
 */
export class PostgresRunNotifier implements RunNotifier {
	private readonly registry = new RunWakeupRegistry();
	private client: Client | null = null;
	private connecting: Promise<void> | null = null;

	constructor(private readonly connectionString: string) {}

	async subscribe(runId: string): Promise<RunSubscription> {
		await this.ensureListening();
		return this.registry.subscribe(runId);
	}

	private ensureListening(): Promise<void> {
		if (this.client) return Promise.resolve();
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			const client = new PgClient({ connectionString: this.connectionString });
			client.on("notification", (msg) => {
				const runId = parseRunNotification(msg.payload);
				if (runId) this.registry.signal(runId);
			});
			await client.connect();
			await client.query(`LISTEN ${RUN_EVENTS_CHANNEL}`);
			this.client = client;
		})();
		return this.connecting;
	}

	async close(): Promise<void> {
		const client = this.client;
		this.client = null;
		this.connecting = null;
		if (client) await client.end();
	}
}
