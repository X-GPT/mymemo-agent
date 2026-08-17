import type { CanaryPublishResult } from "agentcore-canary-dispatch/publisher";
import {
	type AdvisoryLockPool,
	tryWithAdvisoryLock,
} from "../cleanup/advisory-lock";
import { toMessage, type WorkerLogger } from "../logger";

export const AGENTCORE_DISPATCH_PUBLISHER_ADVISORY_LOCK_KEY = 8_242_869_154_306_403;

export interface AgentCoreDispatchPublisher {
	publishPending(): Promise<CanaryPublishResult>;
}

export interface AgentCoreDispatchPendingStore {
	oldestUnpublishedAdmittedAt(): Promise<Date | null>;
}

export interface AgentCoreDispatchPublisherLoopOptions {
	pool: AdvisoryLockPool;
	publisher: AgentCoreDispatchPublisher;
	pendingStore: AgentCoreDispatchPendingStore;
	intervalMs: number;
	now?: () => Date;
	logger: WorkerLogger;
}

export type AgentCoreDispatchPublisherTickResult =
	| { outcome: "published" | "disabled" | "error"; pendingAgeMs: number }
	| { outcome: "lost_lock" };

function recordLostLock(logger: WorkerLogger): void {
	logger.info({
		message: "AgentCore dispatch publisher metric",
		outcome: "lost_lock",
		PublisherLostLock: 1,
		_aws: {
			Timestamp: Date.now(),
			CloudWatchMetrics: [
				{
					Namespace: "MyMemo/AgentCoreDispatch",
					Dimensions: [[]],
					Metrics: [{ Name: "PublisherLostLock", Unit: "Count" }],
				},
			],
		},
	});
}

function recordPendingAge(
	logger: WorkerLogger,
	outcome: "published" | "disabled",
	pendingAgeMs: number,
): void {
	logger.info({
		message: "AgentCore dispatch publisher metric",
		outcome,
		PendingAgeMs: pendingAgeMs,
		_aws: {
			Timestamp: Date.now(),
			CloudWatchMetrics: [
				{
					Namespace: "MyMemo/AgentCoreDispatch",
					Dimensions: [[]],
					Metrics: [{ Name: "PendingAgeMs", Unit: "Milliseconds" }],
				},
			],
		},
	});
}

function recordPublisherError(
	logger: WorkerLogger,
	pendingAgeMs: number,
	reason: "ambiguous_send" | "tick_failed",
	details: Record<string, unknown>,
): void {
	logger.error({
		message: "AgentCore dispatch publisher metric",
		outcome: "error",
		reason,
		...details,
		PendingAgeMs: pendingAgeMs,
		PublisherErrors: 1,
		_aws: {
			Timestamp: Date.now(),
			CloudWatchMetrics: [
				{
					Namespace: "MyMemo/AgentCoreDispatch",
					Dimensions: [[]],
					Metrics: [
						{ Name: "PublisherErrors", Unit: "Count" },
						{ Name: "PendingAgeMs", Unit: "Milliseconds" },
					],
				},
			],
		},
	});
}

export class AgentCoreDispatchPublisherLoop {
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inFlight: Promise<AgentCoreDispatchPublisherTickResult> | undefined;

	constructor(
		private readonly options: AgentCoreDispatchPublisherLoopOptions,
	) {}

	async runOnce(): Promise<AgentCoreDispatchPublisherTickResult> {
		const now = this.options.now ?? (() => new Date());
		let pendingAgeMs = 0;
		try {
			const locked = await tryWithAdvisoryLock(
				this.options.pool,
				AGENTCORE_DISPATCH_PUBLISHER_ADVISORY_LOCK_KEY,
				async () => {
					const oldest =
						await this.options.pendingStore.oldestUnpublishedAdmittedAt();
					pendingAgeMs = oldest
						? Math.max(0, now().getTime() - oldest.getTime())
						: 0;
					return await this.options.publisher.publishPending();
				},
			);
			if (!locked.ran) {
				recordLostLock(this.options.logger);
				return { outcome: "lost_lock" };
			}
			if (locked.result.ambiguousRunIds.length > 0) {
				recordPublisherError(
					this.options.logger,
					pendingAgeMs,
					"ambiguous_send",
					{ ambiguousCount: locked.result.ambiguousRunIds.length },
				);
				return { outcome: "error", pendingAgeMs };
			}
			const outcome =
				locked.result.status === "disabled" ? "disabled" : "published";
			recordPendingAge(this.options.logger, outcome, pendingAgeMs);
			return { outcome, pendingAgeMs };
		} catch (error) {
			recordPublisherError(this.options.logger, pendingAgeMs, "tick_failed", {
				error: toMessage(error),
			});
			return { outcome: "error", pendingAgeMs };
		}
	}

	/** Start the continuous publisher. The first tick is due within one interval. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.scheduleNext();
	}

	/** Stop future ticks and wait for the lock held by an active tick to release. */
	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.inFlight;
	}

	private scheduleNext(delayMs = this.options.intervalMs): void {
		this.timer = setTimeout(() => void this.tick(), delayMs);
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		this.timer = undefined;
		const startedAt = performance.now();
		const inFlight = this.runOnce();
		this.inFlight = inFlight;
		try {
			await inFlight;
		} finally {
			if (this.inFlight === inFlight) this.inFlight = undefined;
			if (this.running) {
				const remainingMs = Math.max(
					0,
					this.options.intervalMs - (performance.now() - startedAt),
				);
				this.scheduleNext(remainingMs);
			}
		}
	}
}
