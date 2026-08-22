import type { Database } from "@mymemo/agent-db/client";
import {
	expireUnownedQueuedRunsTx,
	reclaimConversationTx,
} from "@mymemo/agent-db/run-store";
import {
	type AdvisoryLockPool,
	CLEANUP_ADVISORY_LOCK_KEY,
	tryWithAdvisoryLock,
} from "./cleanup/advisory-lock";
import {
	type ArtifactObjectJanitor,
	type CleanupSummary,
	runCleanupPass,
	type SandboxJanitor,
} from "./cleanup/cleanup";
import { toMessage, type WorkerLogger } from "./logger";

const RUN_LIVENESS_SWEEP_INTERVAL_MS = 15_000;

export interface MaintenanceLiveStreamTelemetry {
	record(
		operation: "degradation",
		result: "started" | "ended",
		options: {
			reason: "stale_worker";
			durationMs?: number;
		},
	): void;
}

export interface MaintenanceRunnerOptions {
	db: Database;
	/** Dedicated-connection source for the single-flight cleanup lock. */
	pool: AdvisoryLockPool;
	sandboxJanitor: SandboxJanitor;
	artifactJanitor: ArtifactObjectJanitor;
	workerId: string;
	cleanupIntervalMs: number;
	logger: WorkerLogger;
	/** Optional payload-free metrics capability; no Redis client is loaded here. */
	liveStreamTelemetry?: MaintenanceLiveStreamTelemetry;
}

/** Global queued-Run expiration, fenced Reclamation, and resource cleanup.
 * This runner never Claims or serves Runs. */
export class MaintenanceRunner {
	private running = false;
	private livenessTimer: ReturnType<typeof setTimeout> | undefined;
	private cleanupTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly opts: MaintenanceRunnerOptions) {}

	/** Expire old unowned queued Runs before reclaiming lapsed Ownership. */
	async runLivenessOnce(): Promise<void> {
		const expirationSucceeded = await this.tryExpireUnownedQueuedRuns();
		const reclamationSucceeded = await this.tryReclaimConversations();
		if (expirationSucceeded && reclamationSucceeded) {
			this.opts.logger.info({
				message: "maintenance liveness pass complete",
				workerId: this.opts.workerId,
			});
		}
	}

	/** Attempt one advisory-lock-protected cleanup pass. Never throws. */
	async runCleanupOnce(): Promise<CleanupSummary | undefined> {
		try {
			const outcome = await tryWithAdvisoryLock(
				this.opts.pool,
				CLEANUP_ADVISORY_LOCK_KEY,
				() =>
					runCleanupPass({
						db: this.opts.db,
						sandboxJanitor: this.opts.sandboxJanitor,
						artifactJanitor: this.opts.artifactJanitor,
						workerId: this.opts.workerId,
						logger: this.opts.logger,
					}),
			);
			if (!outcome.ran) return undefined;
			this.opts.logger.info({
				message: "cleanup pass complete",
				workerId: this.opts.workerId,
				...outcome.result,
			});
			return outcome.result;
		} catch (error) {
			this.opts.logger.error({
				message: "cleanup pass failed",
				workerId: this.opts.workerId,
				error: toMessage(error),
			});
			return undefined;
		}
	}

	/** Start liveness immediately; cleanup keeps its existing delayed cadence. */
	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.cleanupTimer = setTimeout(
			() => void this.runCleanupTick(),
			this.opts.cleanupIntervalMs,
		);
		await this.runLivenessOnce();
		if (this.running) {
			this.livenessTimer = setTimeout(
				() => void this.runLivenessTick(),
				RUN_LIVENESS_SWEEP_INTERVAL_MS,
			);
		}
	}

	/** Stop scheduling work. In-flight maintenance finishes on its own. */
	stop(): void {
		this.running = false;
		if (this.livenessTimer) clearTimeout(this.livenessTimer);
		if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
		this.livenessTimer = undefined;
		this.cleanupTimer = undefined;
	}

	private async runLivenessTick(): Promise<void> {
		if (!this.running) return;
		try {
			await this.runLivenessOnce();
		} finally {
			if (this.running) {
				this.livenessTimer = setTimeout(
					() => void this.runLivenessTick(),
					RUN_LIVENESS_SWEEP_INTERVAL_MS,
				);
			}
		}
	}

	private async runCleanupTick(): Promise<void> {
		if (!this.running) return;
		try {
			await this.runCleanupOnce();
		} finally {
			if (this.running) {
				this.cleanupTimer = setTimeout(
					() => void this.runCleanupTick(),
					this.opts.cleanupIntervalMs,
				);
			}
		}
	}

	private async tryReclaimConversations(): Promise<boolean> {
		try {
			for (;;) {
				const reclamation = await reclaimConversationTx(this.opts.db);
				if (!reclamation) break;
				if (reclamation.runs.length > 0) {
					this.opts.logger.warn({
						message: "reclaimed Conversation",
						workerId: this.opts.workerId,
						conversationId: reclamation.conversationId,
						reclaimedRuns: reclamation.runs.map((run) => ({
							runId: run.runId,
							status: run.status,
						})),
					});
				}
				for (const run of reclamation.runs) {
					if (run.liveStreamFailedAt === null) continue;
					if (run.liveStreamFailureMarkedByReclamation) {
						this.opts.liveStreamTelemetry?.record("degradation", "started", {
							reason: "stale_worker",
						});
					}
					this.opts.liveStreamTelemetry?.record("degradation", "ended", {
						reason: "stale_worker",
						durationMs: Math.max(
							0,
							Date.now() - run.liveStreamFailedAt.getTime(),
						),
					});
				}
			}
			return true;
		} catch (error) {
			this.opts.logger.error({
				message: "Conversation Reclamation failed",
				workerId: this.opts.workerId,
				error: toMessage(error),
			});
			return false;
		}
	}

	private async tryExpireUnownedQueuedRuns(): Promise<boolean> {
		try {
			for (;;) {
				const expiration = await expireUnownedQueuedRunsTx(this.opts.db);
				if (!expiration) break;
				this.opts.logger.warn({
					message: "expired unowned queued Runs",
					workerId: this.opts.workerId,
					conversationId: expiration.conversationId,
					expiredRuns: expiration.runs.map((run) => ({
						runId: run.runId,
						status: run.status,
					})),
				});
			}
			return true;
		} catch (error) {
			this.opts.logger.error({
				message: "unowned queue timeout sweep failed",
				workerId: this.opts.workerId,
				error: toMessage(error),
			});
			return false;
		}
	}
}
