import { setTimeout as sleep } from "node:timers/promises";
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

interface AgentCoreDispatchPublisherTickOptions {
	pool: AdvisoryLockPool;
	publisher: AgentCoreDispatchPublisher;
	pendingStore: AgentCoreDispatchPendingStore;
	now?: () => Date;
	logger: WorkerLogger;
}

interface AgentCoreDispatchPublisherOptions
	extends AgentCoreDispatchPublisherTickOptions {
	intervalMs: number;
	signal: AbortSignal;
	wait?: (intervalMs: number, signal: AbortSignal) => Promise<void>;
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

/** Publish one bounded batch while this task owns the deployment-overlap lock. */
export async function publishAgentCoreDispatchTick(
	options: AgentCoreDispatchPublisherTickOptions,
): Promise<AgentCoreDispatchPublisherTickResult> {
	const now = options.now ?? (() => new Date());
	let pendingAgeMs = 0;
	const locked = await tryWithAdvisoryLock(
		options.pool,
		AGENTCORE_DISPATCH_PUBLISHER_ADVISORY_LOCK_KEY,
		async () => {
			const oldest = await options.pendingStore.oldestUnpublishedAdmittedAt();
			pendingAgeMs = oldest
				? Math.max(0, now().getTime() - oldest.getTime())
				: 0;
			return await options.publisher.publishPending();
		},
	);

	if (!locked.ran) {
		recordLostLock(options.logger);
		return { outcome: "lost_lock" };
	}
	if (locked.result.ambiguousRunIds.length > 0) {
		recordPublisherError(options.logger, pendingAgeMs, "ambiguous_send", {
			ambiguousCount: locked.result.ambiguousRunIds.length,
		});
		return { outcome: "error", pendingAgeMs };
	}

	const outcome =
		locked.result.status === "disabled" ? "disabled" : "published";
	recordPendingAge(options.logger, outcome, pendingAgeMs);
	return { outcome, pendingAgeMs };
}

async function waitForNextTick(
	intervalMs: number,
	signal: AbortSignal,
): Promise<void> {
	try {
		await sleep(intervalMs, undefined, { signal });
	} catch (error) {
		if (!signal.aborted) throw error;
	}
}

/** Run the dedicated publisher task until its shutdown signal aborts. */
export async function runAgentCoreDispatchPublisher(
	options: AgentCoreDispatchPublisherOptions,
): Promise<void> {
	const wait = options.wait ?? waitForNextTick;
	while (!options.signal.aborted) {
		try {
			await publishAgentCoreDispatchTick(options);
		} catch (error) {
			recordPublisherError(options.logger, 0, "tick_failed", {
				error: toMessage(error),
			});
		}
		if (!options.signal.aborted) {
			await wait(options.intervalMs, options.signal);
		}
	}
}
