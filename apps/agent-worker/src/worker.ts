import type { WorkerLogger } from "./logger";

export interface WorkerOptions {
	workerId: string;
	maxConcurrentRuns: number;
	shutdownTimeoutMs: number;
	logger: WorkerLogger;
}

export interface HealthSnapshot {
	status: "ok";
	workerId: string;
	activeRuns: number;
	maxConcurrentRuns: number;
	draining: boolean;
}

/**
 * Bounded-concurrency task supervisor for the worker process. In the deployable
 * skeleton it owns concurrency limiting, active-task tracking, graceful drain,
 * and the health snapshot. The Postgres poll/claim loop (a later milestone)
 * drives it by calling `tryStart` for each claimed run; the skeleton keeps that
 * mechanism testable without a queue.
 */
export class Worker {
	readonly workerId: string;
	private readonly maxConcurrentRuns: number;
	private readonly shutdownTimeoutMs: number;
	private readonly logger: WorkerLogger;
	private readonly active = new Set<Promise<void>>();
	private draining = false;

	constructor(options: WorkerOptions) {
		this.workerId = options.workerId;
		this.maxConcurrentRuns = options.maxConcurrentRuns;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs;
		this.logger = options.logger;
	}

	get activeCount(): number {
		return this.active.size;
	}

	get isDraining(): boolean {
		return this.draining;
	}

	/**
	 * Start a task if there is capacity and the worker is not draining. Returns
	 * whether it started, so the caller (the future claim loop) can back off and
	 * leave the run on the queue. Task failures are logged and isolated — one
	 * failing run never rejects another or the supervisor.
	 */
	tryStart(task: () => Promise<void>): boolean {
		if (this.draining) return false;
		if (this.active.size >= this.maxConcurrentRuns) return false;

		const tracked = this.runIsolated(task);
		this.active.add(tracked);
		void tracked.finally(() => {
			this.active.delete(tracked);
		});
		return true;
	}

	private async runIsolated(task: () => Promise<void>): Promise<void> {
		try {
			await task();
		} catch (error) {
			this.logger.error({
				message: "Worker task failed",
				workerId: this.workerId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Await all in-flight tasks (no timeout). Used by tests and clean drains. */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.active]);
	}

	/**
	 * Stop accepting new tasks and wait for in-flight ones to finish, bounded by
	 * `shutdownTimeoutMs`. Returns when drained or when the grace period elapses,
	 * whichever comes first, so a hung task cannot block process exit forever.
	 */
	async shutdown(): Promise<void> {
		this.draining = true;
		if (this.active.size === 0) return;

		this.logger.info({
			message: "Draining active runs before shutdown",
			workerId: this.workerId,
			activeRuns: this.active.size,
			timeoutMs: this.shutdownTimeoutMs,
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, this.shutdownTimeoutMs);
		});
		try {
			await Promise.race([this.drain(), grace]);
		} finally {
			if (timer) clearTimeout(timer);
		}

		if (this.active.size > 0) {
			this.logger.warn({
				message: "Shutdown grace period elapsed with active runs remaining",
				workerId: this.workerId,
				activeRuns: this.active.size,
			});
		}
	}

	healthSnapshot(): HealthSnapshot {
		return {
			status: "ok",
			workerId: this.workerId,
			activeRuns: this.active.size,
			maxConcurrentRuns: this.maxConcurrentRuns,
			draining: this.draining,
		};
	}
}
