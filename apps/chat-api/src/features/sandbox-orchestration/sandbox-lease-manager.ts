import type { LeaseRef, LeaseStore } from "@/features/lease-store";
import type { WorkspaceStore } from "@/features/workspace-store";
import { ConversationBusyError, SandboxCreationError } from "./errors";
import { LeaseHeartbeat } from "./lease-heartbeat";
import type {
	SandboxDaemonEndpoint,
	SandboxHandle,
	SandboxProvider,
	SyncLogger,
} from "./sandbox-provider";

/**
 * Sandbox leasing (Milestone 5). A sandbox is leased by `{userId, conversationId}`
 * and reused across turns while warm, instead of per-turn create/kill.
 *
 * Concurrency is an **ownership lease** in Postgres (see {@link LeaseStore}):
 * `acquire` claims the conversation via an atomic CAS — granted only if the lease
 * is free or expired — so two replicas can never both create a sandbox for one
 * conversation, and a concurrent turn is rejected with `ConversationBusyError`.
 * A {@link LeaseHeartbeat} renews the lease (and the sandbox's E2B timeout) while
 * the turn runs, so a turn longer than the idle window isn't killed mid-stream;
 * if the heartbeat finds the lease was stolen (this process stalled past the TTL)
 * it aborts the turn. A crashed owner's lease simply expires and another replica
 * takes over — no TTL-free advisory lock, no in-process guard.
 *
 * `release` ends the turn: on success it keeps the sandbox warm and persists the
 * pointer; on failure it drops the lease and kills the sandbox (so the next turn
 * never reattaches a broken one). The warm sandbox's own E2B auto-shutdown
 * timeout reaps it if no turn reuses it within the idle window. Health/version
 * recycle gating before reuse is a follow-up (MYM-19); `terminate` is the
 * unconditional teardown hook cancellation/recycle drive.
 */

/** Default lease TTL: the deadline the heartbeat renews. Short, so a crashed
 * owner frees its conversation quickly — the heartbeat decouples this from turn
 * length, so long turns are fine. */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** How often the heartbeat renews the lease (well under the TTL). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
/** Idle window before E2B auto-kills an inactive warm sandbox (between turns). */
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface AcquireOptions {
	/** Claude SDK resume state to thread into the turn (overrides the recorded
	 * session; an explicit `null` starts fresh). */
	agentSessionId?: string | null;
}

export interface SandboxLeaseManagerOptions {
	idleTimeoutMs?: number;
	leaseTtlMs?: number;
	heartbeatIntervalMs?: number;
}

/**
 * A held lease on a sandbox for one turn. The caller forwards the turn through
 * `sandbox` + `daemon` (passing `abortSignal` to the daemon call so a lost lease
 * aborts it), then must `release` the lease.
 */
export interface SandboxLease {
	readonly userId: string;
	readonly conversationId: string;
	readonly sandbox: SandboxHandle;
	readonly daemon: SandboxDaemonEndpoint;
	/** True when an existing warm sandbox was reused; false when freshly created. */
	readonly reused: boolean;
	/** Resume state threaded into the turn (null when starting fresh). */
	readonly agentSessionId: string | null;
	/** This hold's fencing token — guards the heartbeat/release writes. */
	readonly fencingToken: number;
	/** Aborts when the turn must stop (the lease was lost mid-turn). */
	readonly abortSignal: AbortSignal;
	/** Stops this turn's heartbeat. Internal — called by `release`. */
	readonly stopHeartbeat: () => void;
}

export interface SandboxLeaseManagerDeps {
	sandboxProvider: SandboxProvider;
	leaseStore: LeaseStore;
	workspaceStore: Pick<
		WorkspaceStore,
		"hydrateConversationWorkspace" | "syncConversationWorkspace"
	>;
}

function resolveAgentSessionId(
	opts: AcquireOptions,
	fallback: string | null,
): string | null {
	return opts.agentSessionId !== undefined ? opts.agentSessionId : fallback;
}

export class SandboxLeaseManager {
	private readonly idleTimeoutMs: number;
	private readonly leaseTtlMs: number;
	private readonly heartbeatIntervalMs: number;

	constructor(
		private readonly deps: SandboxLeaseManagerDeps,
		/** This process instance's identity — who holds a lease. Minted at boot. */
		private readonly ownerId: string,
		options: SandboxLeaseManagerOptions = {},
	) {
		this.idleTimeoutMs =
			options.idleTimeoutMs ?? DEFAULT_SANDBOX_IDLE_TIMEOUT_MS;
		this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
		this.heartbeatIntervalMs =
			options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	}

	/**
	 * Lease a sandbox for one turn of `{userId, conversationId}`. Claims the
	 * conversation's ownership lease (rejecting with `ConversationBusyError` when
	 * another turn holds it), reuses the warm sandbox the claim points at or
	 * creates a fresh one, and starts the heartbeat. A `SandboxCreationError` is
	 * retried once. If the lease can't be made usable, the held lease is dropped so
	 * the conversation isn't wedged owned-but-dead.
	 */
	async acquire(
		ref: LeaseRef,
		logger: SyncLogger,
		opts: AcquireOptions = {},
	): Promise<SandboxLease> {
		const claim = await this.deps.leaseStore.claimLease(
			ref,
			this.ownerId,
			this.leaseTtlMs,
		);
		if (!claim) {
			throw new ConversationBusyError(
				`Conversation ${ref.conversationId} already has a turn in flight`,
			);
		}
		const { fencingToken } = claim;
		const agentSessionId = resolveAgentSessionId(opts, claim.agentSessionId);

		try {
			const reused = claim.sandboxId
				? await this.tryReuse(claim.sandboxId, logger)
				: null;
			const parts = reused ?? (await this.acquireFresh(ref, logger));

			const controller = new AbortController();
			const heartbeat = new LeaseHeartbeat(
				() => this.beat(ref, fencingToken, parts.sandbox, logger),
				() => {
					logger.error({
						msg: "Lease lost mid-turn, aborting",
						userId: ref.userId,
						conversationId: ref.conversationId,
					});
					controller.abort();
				},
				this.heartbeatIntervalMs,
			);
			heartbeat.start();

			logger.info({
				msg: parts.reused ? "Reusing warm sandbox lease" : "Leased fresh sandbox",
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandboxId: parts.sandbox.sandboxId,
				reused: parts.reused,
				resuming: agentSessionId !== null,
			});

			return {
				userId: ref.userId,
				conversationId: ref.conversationId,
				sandbox: parts.sandbox,
				daemon: parts.daemon,
				reused: parts.reused,
				agentSessionId,
				fencingToken,
				abortSignal: controller.signal,
				stopHeartbeat: () => heartbeat.stop(),
			};
		} catch (err) {
			// We hold the lease but couldn't produce a usable sandbox — drop it so
			// the conversation is immediately claimable again, not wedged.
			await this.deps.leaseStore
				.dropLease(ref, this.ownerId, fencingToken)
				.catch(() => {});
			throw err;
		}
	}

	/**
	 * End a turn's hold. On success the sandbox is kept warm and the pointer
	 * persisted; on failure the lease is dropped and the sandbox killed so the next
	 * turn never reattaches a broken one. The owner+token guard means a hold stolen
	 * mid-turn writes nothing. A cleanup error is logged, not thrown.
	 */
	async release(
		lease: SandboxLease,
		logger: SyncLogger,
		opts: { ok: boolean } = { ok: true },
	): Promise<void> {
		lease.stopHeartbeat();
		const ref: LeaseRef = {
			userId: lease.userId,
			conversationId: lease.conversationId,
		};
		try {
			if (opts.ok) {
				// Reset the idle countdown from turn end, sync, persist + free the lease.
				await this.deps.sandboxProvider.setSandboxTimeout(
					lease.sandbox,
					this.idleTimeoutMs,
					logger,
				);
				await this.deps.workspaceStore.syncConversationWorkspace(ref);
				await this.deps.leaseStore.releaseLease(
					ref,
					this.ownerId,
					lease.fencingToken,
					{
						sandboxId: lease.sandbox.sandboxId,
						agentSessionId: lease.agentSessionId,
					},
				);
			} else {
				// Failed turn: drop the lease and tear the sandbox down (an abandoned
				// daemon turn keeps running otherwise, and the next turn would reattach
				// a broken/busy sandbox). Sync first so any durable state is captured.
				await this.deps.workspaceStore
					.syncConversationWorkspace(ref)
					.catch((err) => {
						logger.error({
							msg: "Workspace sync before terminate failed",
							userId: ref.userId,
							conversationId: ref.conversationId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				await this.deps.leaseStore.dropLease(ref, this.ownerId, lease.fencingToken);
				await this.deps.sandboxProvider.killSandbox(
					lease.userId,
					lease.sandbox,
					logger,
				);
			}
		} catch (err) {
			logger.error({
				msg: "Lease release cleanup failed",
				userId: lease.userId,
				conversationId: lease.conversationId,
				ok: opts.ok,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Unconditional teardown hook (cancellation / recycle): kill the sandbox the
	 * lease points at and delete the row, regardless of owner. Idempotent and
	 * best-effort — a missing row or already-reaped sandbox is a no-op.
	 */
	async terminate(ref: LeaseRef, logger: SyncLogger): Promise<void> {
		const record = await this.deps.leaseStore.get(ref);
		if (!record) return;
		if (record.sandboxId) {
			try {
				const handle = await this.deps.sandboxProvider.connectSandbox(
					record.sandboxId,
					logger,
				);
				await this.deps.sandboxProvider.killSandbox(ref.userId, handle, logger);
			} catch (err) {
				logger.info({
					msg: "Sandbox already gone on terminate",
					userId: ref.userId,
					conversationId: ref.conversationId,
					sandboxId: record.sandboxId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		await this.deps.leaseStore.delete(ref);
	}

	/** One heartbeat: renew the lease and the sandbox's E2B timeout in parallel. */
	private async beat(
		ref: LeaseRef,
		fencingToken: number,
		sandbox: SandboxHandle,
		logger: SyncLogger,
	): Promise<boolean> {
		const [held] = await Promise.all([
			this.deps.leaseStore.renewLease(
				ref,
				this.ownerId,
				fencingToken,
				this.leaseTtlMs,
			),
			// Same beat renews the E2B timeout — this is the long-turn keep-alive.
			// Best-effort: a failure leaves the prior timeout, never aborts the turn.
			this.deps.sandboxProvider
				.setSandboxTimeout(sandbox, this.idleTimeoutMs, logger)
				.then(
					() => undefined,
					() => undefined,
				),
		]);
		return held;
	}

	/**
	 * Reattach to the warm sandbox the lease points at, or `null` when it no longer
	 * reattaches (stale) — the caller then creates a fresh one. The daemon endpoint
	 * is recomputed from the live handle, never read from the store. Daemon-health /
	 * version-drift gating before reuse is a follow-up (MYM-19).
	 */
	private async tryReuse(
		sandboxId: string,
		logger: SyncLogger,
	): Promise<{
		sandbox: SandboxHandle;
		daemon: SandboxDaemonEndpoint;
		reused: boolean;
	} | null> {
		let sandbox: SandboxHandle;
		try {
			sandbox = await this.deps.sandboxProvider.connectSandbox(sandboxId, logger);
		} catch (err) {
			logger.info({
				msg: "Warm lease is stale, recreating",
				sandboxId,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
		await this.deps.sandboxProvider.setSandboxTimeout(
			sandbox,
			this.idleTimeoutMs,
			logger,
		);
		return {
			sandbox,
			daemon: this.deps.sandboxProvider.daemonEndpoint(sandbox),
			reused: true,
		};
	}

	/**
	 * Create a fresh sandbox for the conversation and hydrate its durable
	 * workspace. The warm pointer is written at `release`, not here, so a crash
	 * before release leaves only an expired lease (the half-created sandbox is
	 * reaped by E2B). A created sandbox that can't be made usable is torn down.
	 */
	private async acquireFresh(
		ref: LeaseRef,
		logger: SyncLogger,
	): Promise<{
		sandbox: SandboxHandle;
		daemon: SandboxDaemonEndpoint;
		reused: boolean;
	}> {
		await this.deps.workspaceStore.hydrateConversationWorkspace(ref);
		const sandbox = await this.createWithRetry(ref.userId, logger);
		try {
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
			return { sandbox, daemon, reused: false };
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
