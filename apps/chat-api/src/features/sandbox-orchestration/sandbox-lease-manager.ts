import type { LeaseRef, LeaseStore } from "@/features/lease-store";
import type { WorkspaceStore } from "@/features/workspace-store";
import { ConversationBusyError, SandboxCreationError } from "./errors";
import type {
	SandboxDaemonEndpoint,
	SandboxHandle,
	SandboxProvider,
	SyncLogger,
} from "./sandbox-provider";

/**
 * Sandbox leasing for Milestone 5. Today every turn creates a fresh per-turn
 * sandbox and tears it down (`runSandboxChat`). This manager moves toward warm
 * conversation sandboxes: a sandbox is leased by `{userId, conversationId}` and
 * may be reused across turns while it stays warm.
 *
 * The warm-sandbox pointer is persisted in the durable {@link LeaseStore}
 * (Postgres), not a per-process Map, so a restarted process or a second replica
 * finds and reuses the same sandbox. The store holds only the sandbox *id* plus
 * the daemon endpoint — a live handle is an open network client that can't be
 * serialized — so reuse reattaches through `SandboxProvider.connectSandbox`.
 *
 * Scope of this task (Task 13): the lease lifecycle — keyed reuse, isolation,
 * the concurrency policy, fresh create + hydrate, and threading `agentSessionId`
 * for resume. Two follow-ups build on it: idle termination (Task 14) decides
 * *when* a warm lease is reaped (reading `sandbox_leases.updated_at`), and
 * recycle conditions (Task 15) add daemon-health / version-drift gating before a
 * warm lease is reused. Neither is implemented here; `release` keeps the sandbox
 * warm and `terminate` is the explicit hook those tasks drive.
 *
 * Concurrency policy: **reject**. A second turn for a conversation whose lease is
 * already in flight throws `ConversationBusyError`. The in-flight guard is
 * per-process, so it only serializes turns landing on the same process. The
 * daemon's single-turn lock backstops two turns that reuse the *same* warm
 * sandbox (it 409s the second), but it does NOT cover a cross-replica race where
 * neither replica has a warm lease yet: both would `acquireFresh` and create
 * distinct sandboxes, and the conflicting `upsert` orphans one. A DB-level guard
 * (conditional insert / advisory lock on the lease key) closes that gap and is
 * left to the Task 14 wiring that puts this on the live multi-replica path.
 */

export interface AcquireOptions {
	/**
	 * Claude SDK resume state to thread into the turn. On a fresh (non-reused)
	 * sandbox this is what lets the daemon's SessionStore resume prior agent
	 * context; on a warm reuse the live process already holds it.
	 */
	agentSessionId?: string | null;
}

/**
 * A held lease on a sandbox for one turn. The caller forwards the turn through
 * `sandbox` + `daemon`, then must `release` the lease.
 */
export interface SandboxLease {
	readonly userId: string;
	readonly conversationId: string;
	readonly sandbox: SandboxHandle;
	readonly daemon: SandboxDaemonEndpoint;
	/**
	 * True when an existing warm sandbox was reused; false when this acquisition
	 * created and hydrated a fresh one. Lets run events / logs distinguish warm
	 * reuse from a fresh hydrate+resume.
	 */
	readonly reused: boolean;
	/** Resume state threaded into the turn (null when starting fresh). */
	readonly agentSessionId: string | null;
}

export interface SandboxLeaseManagerDeps {
	sandboxProvider: SandboxProvider;
	leaseStore: LeaseStore;
	workspaceStore: Pick<
		WorkspaceStore,
		"hydrateConversationWorkspace" | "syncConversationWorkspace"
	>;
}

/**
 * `userId` and `conversationId` are caller-supplied opaque strings. A naive
 * `${userId}:${conversationId}` join would collide (`a` + `b:c` vs `a:b` + `c`),
 * which would let one conversation's in-flight guard mask another's. A NUL
 * separator — which neither id can contain — keeps the key injective. (Durable
 * isolation is enforced separately by the store's composite primary key.)
 */
function inFlightKey(ref: LeaseRef): string {
	return `${ref.userId}\0${ref.conversationId}`;
}

export class SandboxLeaseManager {
	/** Keys of conversations with a turn currently in flight (reject policy). */
	private readonly inFlight = new Set<string>();

	constructor(private readonly deps: SandboxLeaseManagerDeps) {}

	/**
	 * Lease a sandbox for one turn of `{userId, conversationId}`.
	 *
	 * - A persisted warm lease whose sandbox still reattaches is reused
	 *   (`reused: true`).
	 * - A conversation whose turn is still in flight is rejected with
	 *   `ConversationBusyError` (the reject concurrency policy).
	 * - Otherwise — no lease, or a stale one whose sandbox is gone — the durable
	 *   workspace is hydrated and a fresh sandbox + daemon are created
	 *   (`reused: false`). A `SandboxCreationError` is retried once, matching the
	 *   per-turn path's transient-create handling.
	 */
	async acquire(
		ref: LeaseRef,
		logger: SyncLogger,
		opts: AcquireOptions = {},
	): Promise<SandboxLease> {
		const key = inFlightKey(ref);
		// No await between the check and the add, so two concurrent acquires for the
		// same conversation can't both pass: the second sees the in-flight key.
		if (this.inFlight.has(key)) {
			throw new ConversationBusyError(
				`Conversation ${ref.conversationId} already has a turn in flight`,
			);
		}
		this.inFlight.add(key);

		try {
			const reused = await this.tryReuse(ref, logger, opts);
			if (reused) return reused;
			return await this.acquireFresh(ref, logger, opts);
		} catch (err) {
			// Free the guard on any failure so the conversation isn't wedged; a
			// successful acquire keeps the key held until `release`.
			this.inFlight.delete(key);
			throw err;
		}
	}

	/**
	 * End a turn's hold on a lease without tearing the sandbox down: the in-flight
	 * guard is freed and the durable workspace is synced, but the sandbox is kept
	 * warm for the next turn. Idle termination of warm leases is Task 14. A sync
	 * failure is logged, not thrown — the turn already finished.
	 */
	async release(lease: SandboxLease, logger: SyncLogger): Promise<void> {
		this.inFlight.delete(inFlightKey(lease));
		try {
			await this.deps.workspaceStore.syncConversationWorkspace({
				userId: lease.userId,
				conversationId: lease.conversationId,
			});
		} catch (err) {
			logger.error({
				msg: "Workspace sync failed on lease release",
				userId: lease.userId,
				conversationId: lease.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Drop a lease and tear its sandbox down: the persisted pointer is removed and
	 * the sandbox killed. The explicit termination hook the idle reaper (Task 14)
	 * and recycle conditions (Task 15) drive. Idempotent and best-effort — an
	 * unknown lease is a no-op, and a sandbox already reaped (connect throws) is
	 * still removed from the store — so cancellation racing teardown never throws.
	 */
	async terminate(ref: LeaseRef, logger: SyncLogger): Promise<void> {
		// Free the in-flight guard too: terminating a lease whose turn is still held
		// (e.g. the reaper races a turn) must not leave the key set, or the
		// conversation is wedged with ConversationBusyError until the process exits.
		this.inFlight.delete(inFlightKey(ref));

		const record = await this.deps.leaseStore.get(ref);
		if (!record) return;
		try {
			const handle = await this.deps.sandboxProvider.connectSandbox(
				record.sandboxId,
				logger,
			);
			await this.deps.sandboxProvider.killSandbox(ref.userId, handle, logger);
		} catch (err) {
			// connect threw → the sandbox is already gone (reaped / never existed),
			// so dropping the pointer below is correct.
			logger.info({
				msg: "Sandbox already gone on terminate",
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandboxId: record.sandboxId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		// Delete only after the kill attempt: deleting first would orphan the
		// sandbox id before we tried to kill it.
		await this.deps.leaseStore.delete(ref);
	}

	/**
	 * Reattach to a persisted warm lease, or `null` when there is none / it is
	 * stale. A stale pointer (the sandbox no longer reattaches) is deleted so the
	 * caller falls through to a fresh create.
	 *
	 * Staleness here is only "the sandbox VM no longer reattaches" — `connectSandbox`
	 * succeeds whenever the control plane still has the sandbox, so a VM that is up
	 * but whose in-sandbox daemon has died (or whose bundle version drifted) is
	 * reused with its persisted endpoint and fails at `/turn`. Daemon-health /
	 * version-drift gating before reuse is Task 15 (recycle conditions); until then
	 * the persisted `daemonUrl`/`trafficAccessToken` are trusted as-is.
	 */
	private async tryReuse(
		ref: LeaseRef,
		logger: SyncLogger,
		opts: AcquireOptions,
	): Promise<SandboxLease | null> {
		const record = await this.deps.leaseStore.get(ref);
		if (!record) return null;

		let sandbox: SandboxHandle;
		try {
			sandbox = await this.deps.sandboxProvider.connectSandbox(
				record.sandboxId,
				logger,
			);
		} catch (err) {
			logger.info({
				msg: "Warm lease is stale, recreating",
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandboxId: record.sandboxId,
				error: err instanceof Error ? err.message : String(err),
			});
			await this.deps.leaseStore.delete(ref);
			return null;
		}

		// A reused live process already holds its resume state; honor an explicit
		// override but otherwise carry the conversation's recorded session forward.
		const agentSessionId = opts.agentSessionId ?? record.agentSessionId ?? null;

		// Reuse is a use: re-persist the pointer so `updated_at` advances. The idle
		// reaper (Task 14) ages leases by that timestamp, so without this a
		// continuously-reused (and thus never-upserted) sandbox would look idle and
		// be reaped mid-use. Also persists an explicit session override so the row
		// doesn't drift from the live lease.
		await this.deps.leaseStore.upsert({ ...record, agentSessionId });

		logger.info({
			msg: "Reusing warm sandbox lease",
			userId: ref.userId,
			conversationId: ref.conversationId,
			sandboxId: record.sandboxId,
			reused: true,
			resuming: agentSessionId !== null,
		});
		return {
			userId: ref.userId,
			conversationId: ref.conversationId,
			sandbox,
			daemon: {
				url: record.daemonUrl,
				trafficAccessToken: record.trafficAccessToken ?? undefined,
			},
			reused: true,
			agentSessionId,
		};
	}

	/**
	 * Create a fresh sandbox for the conversation, hydrate its durable workspace,
	 * and persist the new warm-lease pointer.
	 */
	private async acquireFresh(
		ref: LeaseRef,
		logger: SyncLogger,
		opts: AcquireOptions,
	): Promise<SandboxLease> {
		const agentSessionId = opts.agentSessionId ?? null;

		await this.deps.workspaceStore.hydrateConversationWorkspace(ref);
		const sandbox = await this.createWithRetry(ref.userId, logger);

		// The sandbox now exists; anything past this point that throws must tear it
		// down, or a created-but-unusable sandbox leaks (the per-turn path's
		// `finally { killSandbox }` guaranteed this — there is no caller `finally`
		// here because no lease was handed back).
		try {
			const daemon = await this.deps.sandboxProvider.ensureSandboxDaemon(
				ref.userId,
				sandbox,
				logger,
			);

			await this.deps.leaseStore.upsert({
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandboxId: sandbox.sandboxId,
				daemonUrl: daemon.url,
				trafficAccessToken: daemon.trafficAccessToken ?? null,
				agentSessionId,
			});

			logger.info({
				msg: "Leased fresh sandbox",
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandboxId: sandbox.sandboxId,
				reused: false,
				resuming: agentSessionId !== null,
			});
			return {
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandbox,
				daemon,
				reused: false,
				agentSessionId,
			};
		} catch (err) {
			await this.deps.sandboxProvider.killSandbox(ref.userId, sandbox, logger);
			throw err;
		}
	}

	private async createWithRetry(
		userId: string,
		logger: SyncLogger,
	): Promise<SandboxHandle> {
		try {
			return await this.deps.sandboxProvider.createSandbox(userId, logger);
		} catch (err) {
			if (!(err instanceof SandboxCreationError)) throw err;
			logger.error({
				msg: "Sandbox creation failed, retrying",
				userId,
				error: err.message,
			});
			return this.deps.sandboxProvider.createSandbox(userId, logger);
		}
	}
}
