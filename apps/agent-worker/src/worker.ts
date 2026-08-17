import { FARGATE_EXECUTION_RUNTIME } from "@mymemo/agent-db/execution-runtime";
import type { WorkerLogger } from "./logger";

export interface WorkerOptions {
	workerId: string;
	maxConcurrentConversations: number;
	shutdownTimeoutMs: number;
	logger: WorkerLogger;
}

export interface HealthSnapshot {
	status: "ok";
	executionRuntime: typeof FARGATE_EXECUTION_RUNTIME;
	workerId: string;
	activeConversations: number;
	maxConcurrentConversations: number;
	draining: boolean;
}

/**
 * Bounded-concurrency task supervisor for the worker process: concurrency
 * limiting, active-task tracking, graceful drain, and the health snapshot.
 *
 * Its unit is the **Conversation**, not the Run (ADR-0015): the control loop
 * calls `tryStart` once per Claimed Conversation, and that slot is held for the
 * whole drain of that Conversation's snapshot rather than released between its
 * Runs. Naming it after Runs is how the next reader mis-sizes the fleet — a
 * Conversation serves its Runs one at a time, so a task's real ceiling is
 * concurrent Conversations.
 */
export class Worker {
	readonly workerId: string;
	private readonly maxConcurrentConversations: number;
	private readonly shutdownTimeoutMs: number;
	private readonly logger: WorkerLogger;
	private readonly active = new Set<Promise<void>>();
	private draining = false;

	constructor(options: WorkerOptions) {
		this.workerId = options.workerId;
		this.maxConcurrentConversations = options.maxConcurrentConversations;
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
	 * Whether another Conversation drain may start right now — not draining and
	 * below the concurrency cap. The claim loop checks this before Claiming a
	 * Conversation so it never claims work it cannot immediately dispatch.
	 */
	get hasCapacity(): boolean {
		return !this.draining && this.active.size < this.maxConcurrentConversations;
	}

	/**
	 * Start a task if there is capacity and the worker is not draining. Returns
	 * whether it started, so the claim loop can back off and release the
	 * Conversation instead of holding a lease it cannot serve. Task failures are
	 * logged and isolated — one failing drain never rejects another or the
	 * supervisor.
	 */
	tryStart(task: () => Promise<void>): boolean {
		if (this.draining) return false;
		if (this.active.size >= this.maxConcurrentConversations) return false;

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
			message: "Draining active conversations before shutdown",
			workerId: this.workerId,
			activeConversations: this.active.size,
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
				message:
					"Shutdown grace period elapsed with active conversations remaining",
				workerId: this.workerId,
				activeConversations: this.active.size,
			});
		}
	}

	healthSnapshot(): HealthSnapshot {
		return {
			status: "ok",
			executionRuntime: FARGATE_EXECUTION_RUNTIME,
			workerId: this.workerId,
			activeConversations: this.active.size,
			maxConcurrentConversations: this.maxConcurrentConversations,
			draining: this.draining,
		};
	}
}
