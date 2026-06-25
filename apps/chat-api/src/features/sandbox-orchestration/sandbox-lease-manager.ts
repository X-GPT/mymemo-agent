import type { LeaseRecord, LeaseRef, LeaseStore } from "@/features/lease-store";
import type { WorkspaceStore } from "@/features/workspace-store";
import { ConversationBusyError, SandboxCreationError } from "./errors";
import type {
	SandboxDaemonEndpoint,
	SandboxHandle,
	SandboxProvider,
	SyncLogger,
} from "./sandbox-provider";

/**
 * Sandbox leasing (Milestone 5). A sandbox is leased by `{userId, conversationId}`
 * and reused across turns while warm, instead of the per-turn create/kill of
 * `runSandboxChat`.
 *
 * The warm pointer lives in the durable {@link LeaseStore} (Postgres), not a
 * per-process Map, so a restarted process or second replica finds and reuses the
 * same sandbox. The store holds only the sandbox id + daemon endpoint (a live
 * handle is an unserializable network client), so reuse reattaches through
 * `SandboxProvider.connectSandbox`.
 *
 * Idle has one clock: the sandbox's own E2B auto-shutdown timeout, reset to
 * `idleTimeoutMs` on every acquire/release. The idle window *is* the sandbox's
 * lifetime — E2B reaps an idle sandbox itself and the next acquire finds a stale
 * pointer and recreates — so `release` keeps it warm without leaking. A proactive
 * reaper, keep-alive for long turns, and health/version-drift recycle gating are
 * follow-ups (Tasks 14–15); `terminate` is the teardown hook they drive.
 *
 * Concurrency policy: **reject** — a second in-flight turn for a conversation
 * throws `ConversationBusyError`. The per-process guard handles same-replica
 * concurrency; the cross-replica first-turn race (both replicas see no lease and
 * both `acquireFresh`) is closed by running the decide+create section under the
 * store's `withClaim` advisory lock. The daemon's single-turn lock 409s two turns
 * reusing the *same* warm sandbox once the lease row exists.
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
 * Default idle window before E2B auto-kills an inactive warm sandbox. 5 minutes
 * matches the plan's idle policy (Task 14); a constructor option so config can
 * override it.
 */
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 5 * 60_000;

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

/**
 * Resolve the session to thread into a turn. An explicit `opts.agentSessionId`
 * wins — *including an explicit `null`*, which means "start a fresh session", so
 * a caller can reset a warm conversation. Only when the caller omits the field
 * entirely (`undefined`) do we fall back to the conversation's recorded session.
 */
function resolveAgentSessionId(
	opts: AcquireOptions,
	fallback: string | null,
): string | null {
	return opts.agentSessionId !== undefined ? opts.agentSessionId : fallback;
}

export class SandboxLeaseManager {
	/** Keys of conversations with a turn currently in flight (reject policy). */
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly deps: SandboxLeaseManagerDeps,
		/** Idle window the sandbox timeout is reset to on each acquire/release. */
		private readonly idleTimeoutMs: number = DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
	) {}

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
			// Cross-process claim around the read→reuse-or-create→write section. The
			// in-process guard above only serializes this replica; without this, two
			// replicas that both see no lease would each create a sandbox. Held only
			// while deciding + creating — once the lease row exists, later concurrent
			// turns find the warm sandbox and the daemon's single-turn lock rejects
			// the extra one.
			const claim = await this.deps.leaseStore.withClaim(ref, async () => {
				// Read the pointer once. tryReuse may delete it (stale), so capture the
				// recorded session first and carry it into a fresh create — a recycled
				// sandbox should resume the conversation, not start blank.
				const record = await this.deps.leaseStore.get(ref);
				if (record) {
					const reused = await this.tryReuse(ref, record, logger, opts);
					if (reused) return reused;
				}
				return await this.acquireFresh(
					ref,
					logger,
					resolveAgentSessionId(opts, record?.agentSessionId ?? null),
				);
			});
			if (!claim.acquired) {
				throw new ConversationBusyError(
					`Conversation ${ref.conversationId} is being acquired elsewhere`,
				);
			}
			// `acquired` is true ⇒ the callback ran and returned a lease.
			return claim.result as SandboxLease;
		} catch (err) {
			// Free the guard on any failure so the conversation isn't wedged; a
			// successful acquire keeps the key held until `release`.
			this.inFlight.delete(key);
			throw err;
		}
	}

	/**
	 * End a turn's hold without tearing the sandbox down: sync the durable
	 * workspace, then free the in-flight guard, leaving the sandbox warm. The guard
	 * is held until the sync completes so the next turn can't start against the
	 * same workspace before this turn's state is durably captured. A sync failure
	 * is logged, not thrown (the turn already finished), but still releases the guard.
	 */
	async release(lease: SandboxLease, logger: SyncLogger): Promise<void> {
		// Reset + sync run inside the try so the guard is freed in `finally` no
		// matter what — a throw must not wedge the conversation as busy.
		try {
			// Reset the idle countdown from turn end; E2B auto-kills if no turn reuses.
			await this.deps.sandboxProvider.setSandboxTimeout(
				lease.sandbox,
				this.idleTimeoutMs,
				logger,
			);
			await this.deps.workspaceStore.syncConversationWorkspace({
				userId: lease.userId,
				conversationId: lease.conversationId,
			});
		} catch (err) {
			logger.error({
				msg: "Lease release cleanup failed",
				userId: lease.userId,
				conversationId: lease.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.inFlight.delete(inFlightKey(lease));
		}
	}

	/**
	 * Drop a lease and tear its sandbox down. The explicit teardown hook the idle
	 * reaper (Task 14) and recycle conditions (Task 15) drive. Idempotent and
	 * best-effort — an unknown lease is a no-op, and a sandbox already reaped
	 * (connect throws) is still removed from the store — so cancellation racing
	 * teardown never throws.
	 */
	async terminate(ref: LeaseRef, logger: SyncLogger): Promise<void> {
		// Hold the guard across teardown so a racing `acquire` can't lease the
		// sandbox we're killing; clear it in `finally` so the conversation isn't
		// wedged. (The reaper must not terminate genuinely in-flight leases —
		// enforced where it is wired, Task 14.)
		const key = inFlightKey(ref);
		this.inFlight.add(key);
		try {
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
		} finally {
			this.inFlight.delete(key);
		}
	}

	/**
	 * Reattach to a persisted warm lease, or `null` when there is none / it is
	 * stale (a stale pointer is deleted so the caller falls through to a fresh
	 * create). The daemon endpoint is recomputed from the reattached handle, never
	 * read from the store, so it can't be stale relative to the live sandbox.
	 *
	 * Staleness here is only "the VM no longer reattaches" — a VM that is up but
	 * whose daemon died or whose bundle drifted is reused and fails at `/turn`.
	 * Health / version-drift gating before reuse is Task 15.
	 */
	private async tryReuse(
		ref: LeaseRef,
		record: LeaseRecord,
		logger: SyncLogger,
		opts: AcquireOptions,
	): Promise<SandboxLease | null> {
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

		// Reset the idle countdown: the sandbox may have been near expiry, and the
		// new turn needs a full window so E2B doesn't kill it mid-turn.
		await this.deps.sandboxProvider.setSandboxTimeout(
			sandbox,
			this.idleTimeoutMs,
			logger,
		);

		// A reused live process already holds its resume state; honor an explicit
		// override (including an explicit null = start fresh) but otherwise carry
		// the conversation's recorded session forward.
		const agentSessionId = resolveAgentSessionId(opts, record.agentSessionId);

		// Reuse is a use: re-persist so `updated_at` advances. The idle reaper
		// (Task 14) ages leases by that timestamp, so without this a continuously
		// reused sandbox would look idle and be reaped mid-use. Also persists an
		// explicit session override so the row doesn't drift from the live lease.
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
			// Derived from the reattached handle, not the store — can't be stale.
			daemon: this.deps.sandboxProvider.daemonEndpoint(sandbox),
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
		agentSessionId: string | null,
	): Promise<SandboxLease> {
		await this.deps.workspaceStore.hydrateConversationWorkspace(ref);
		const sandbox = await this.createWithRetry(ref.userId, logger);

		// The sandbox now exists; anything past this that throws must tear it down,
		// or a created-but-unusable sandbox leaks (no caller `finally` here, since
		// no lease was handed back).
		try {
			// Set the warm window explicitly rather than riding E2B's default, so the
			// lease's idle policy and the sandbox's lifetime are one clock.
			await this.deps.sandboxProvider.setSandboxTimeout(
				sandbox,
				this.idleTimeoutMs,
				logger,
			);

			const daemon = await this.deps.sandboxProvider.ensureSandboxDaemon(
				ref.userId,
				sandbox,
				logger,
			);

			await this.deps.leaseStore.upsert({
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandboxId: sandbox.sandboxId,
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
