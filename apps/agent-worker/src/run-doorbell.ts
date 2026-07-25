import { type Client, Client as PgClient } from "pg";
import { toMessage, type WorkerLogger } from "./logger";

/**
 * A wake-up signal that a run may have been queued. Purely a latency
 * optimization over the timer tick (mirroring chat-api's `RunNotifier`): a
 * ring triggers an immediate claim, but delivery is best-effort — a lost ring
 * costs one poll interval, never a run, because the timer tick remains the
 * source of truth. `subscribe` returns the unsubscribe.
 */
export interface RunDoorbell {
	subscribe(onRing: () => void): () => void;
}

/**
 * Coalesces doorbell rings into sequential runs of an async tick. A ring while
 * idle ticks immediately; rings that arrive during an in-flight tick fold into
 * exactly one trailing tick, so a burst of admissions costs one extra claim
 * pass instead of one per ring. Never runs two ticks concurrently. Pure and
 * deterministic — this is where the ring semantics are tested, without a
 * database (the same split as chat-api's `RunWakeupRegistry`).
 */
export class DoorbellTicker {
	private ticking = false;
	private pending = false;
	private stopped = false;

	constructor(
		private readonly tick: () => Promise<void>,
		private readonly onError: (error: unknown) => void,
	) {}

	ring(): void {
		if (this.stopped) return;
		if (this.ticking) {
			this.pending = true;
			return;
		}
		void this.run();
	}

	/** Ignore all further rings. An in-flight tick finishes but its trailing
	 * tick is skipped. */
	stop(): void {
		this.stopped = true;
	}

	private async run(): Promise<void> {
		this.ticking = true;
		try {
			do {
				this.pending = false;
				try {
					await this.tick();
				} catch (error) {
					this.onError(error);
				}
			} while (this.pending && !this.stopped);
		} finally {
			this.ticking = false;
		}
	}
}

/** The channel the `runs_notify_queued` and `runs_notify_interrupt_requested`
 * triggers (agent-db migration 0012) notify on: every queued-run insert and
 * every committed `running` → `interrupt_requested` transition. The payload
 * carries the run id for debugging only — any notification is just a ring. */
export const RUN_DOORBELL_CHANNEL = "run_doorbell";

const RECONNECT_DELAY_MS = 5_000;

/**
 * Postgres `LISTEN/NOTIFY` doorbell. Owns one dedicated `pg` connection (never
 * a pooled/PgBouncer-multiplexed one — a listener must stay pinned to its
 * backend) that `LISTEN`s on {@link RUN_DOORBELL_CHANNEL} and rings the
 * subscriber on every notification. Unlike chat-api's per-request notifier,
 * the worker subscribes once at boot, so a dropped connection reconnects on a
 * timer instead of lazily; while disconnected the run loop's timer tick keeps
 * claiming, so an unavailable doorbell costs latency, never a run. Supports a
 * single subscriber (the run loop), once: unsubscribing closes the doorbell
 * for good — a stop/start cycle of the loop will not revive it, which is fine
 * for the boot-once worker process and keeps the shutdown path one-way.
 */
export class PostgresRunDoorbell implements RunDoorbell {
	private client: Client | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(
		private readonly connectionString: string,
		private readonly logger: WorkerLogger,
	) {}

	subscribe(onRing: () => void): () => void {
		void this.connect(onRing);
		return () => {
			this.closed = true;
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = undefined;
			}
			const client = this.client;
			this.client = null;
			if (client) void client.end().catch(() => {});
		};
	}

	private async connect(onRing: () => void): Promise<void> {
		if (this.closed) return;
		const client = new PgClient({ connectionString: this.connectionString });
		client.on("notification", () => onRing());
		client.on("error", (error) => {
			this.logger.warn({
				message: "run doorbell connection lost; will reconnect",
				error: toMessage(error),
			});
			if (this.client === client) this.client = null;
			void client.end().catch(() => {});
			this.scheduleReconnect(onRing);
		});
		try {
			await client.connect();
			await client.query(`LISTEN ${RUN_DOORBELL_CHANNEL}`);
			if (this.closed) {
				void client.end().catch(() => {});
				return;
			}
			this.client = client;
		} catch (error) {
			this.logger.warn({
				message: "run doorbell connect failed; will retry",
				error: toMessage(error),
			});
			void client.end().catch(() => {});
			this.scheduleReconnect(onRing);
		}
	}

	private scheduleReconnect(onRing: () => void): void {
		if (this.closed || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect(onRing);
		}, RECONNECT_DELAY_MS);
	}
}
