import type { Database } from "@mymemo/agent-db/client";
import type { WorkerLogger } from "../logger";
import {
	type AdvisoryLockPool,
	CLEANUP_ADVISORY_LOCK_KEY,
	tryWithAdvisoryLock,
} from "./advisory-lock";
import {
	type ArtifactObjectJanitor,
	type CleanupSummary,
	runCleanupPass,
	type SandboxJanitor,
} from "./cleanup";

export interface CleanupLoopOptions {
	db: Database;
	/** Dedicated-connection source for the single-flight advisory lock. */
	pool: AdvisoryLockPool;
	sandboxJanitor: SandboxJanitor;
	artifactJanitor: ArtifactObjectJanitor;
	workerId: string;
	/** How often {@link CleanupLoop.start} attempts a pass. */
	intervalMs: number;
	logger: WorkerLogger;
}

/**
 * The worker-embedded cleanup loop (Task 8.1, extended by ADR-0011). On a timer it attempts one
 * {@link runCleanupPass} under the Postgres advisory lock, so across replicas at
 * most one pass runs at a time. It is intentionally independent of the run loop
 * — its own timer, its own error isolation — so a cleanup failure can never
 * block claiming or executing user runs: {@link runOnce} never throws, and a
 * failing pass is logged and retried on the next interval.
 *
 * `runOnce` is directly awaitable so tests drive it deterministically without
 * wall-clock timers (Bun has no `setInterval` fake timers); `start`/`stop` just
 * schedule and unschedule it.
 */
export class CleanupLoop {
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly opts: CleanupLoopOptions) {}

	/**
	 * Attempt one cleanup pass. Returns the pass summary when this replica held
	 * the lock and ran, or `undefined` when another replica held it or the
	 * attempt failed. Never throws — the loop must survive any single failure.
	 */
	async runOnce(): Promise<CleanupSummary | undefined> {
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
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/** Begin attempting a pass every `intervalMs`. The first attempt waits one
	 * interval — cleanup is background hygiene, not startup-critical. */
	start(): void {
		if (this.running) return;
		this.running = true;
		const tick = async (): Promise<void> => {
			if (!this.running) return;
			await this.runOnce();
			if (this.running) this.timer = setTimeout(tick, this.opts.intervalMs);
		};
		this.timer = setTimeout(tick, this.opts.intervalMs);
	}

	/** Stop scheduling further passes. An in-flight pass finishes on its own. */
	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
