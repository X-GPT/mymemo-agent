import { setTimeout as sleep } from "node:timers/promises";
import { type AdvisoryLockPool, tryWithAdvisoryLock } from "./advisory-lock";
import { type PublisherLogger, toMessage } from "./logger";

export const PUBLISHER_ADVISORY_LOCK_KEY = 8_242_869_154_306_403;

export interface AgentCoreDispatchPublishResult {
	status: "enabled" | "disabled";
	publishedRunIds: string[];
	ambiguousRunIds: string[];
}

export interface AgentCoreDispatchPublisher {
	publishPending(): Promise<AgentCoreDispatchPublishResult>;
}

export interface AgentCoreDispatchPendingStore {
	oldestUnpublishedAdmittedAt(): Promise<Date | null>;
}

interface PublisherTickOptions {
	pool: AdvisoryLockPool;
	publisher: AgentCoreDispatchPublisher;
	pendingStore: AgentCoreDispatchPendingStore;
	now?: () => Date;
	logger: PublisherLogger;
}

interface PublisherLoopOptions extends PublisherTickOptions {
	intervalMs: number;
	signal: AbortSignal;
	wait?: (intervalMs: number, signal: AbortSignal) => Promise<void>;
}

export type PublisherTickResult =
	| { outcome: "published" | "disabled" | "error"; pendingAgeMs: number }
	| { outcome: "lost_lock" };

function recordLostLock(logger: PublisherLogger): void {
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
	logger: PublisherLogger,
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
	logger: PublisherLogger,
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

/** Publish one batch while this task owns the deployment-overlap lock. */
export async function publishAgentCoreDispatchTick(
	options: PublisherTickOptions,
): Promise<PublisherTickResult> {
	const now = options.now ?? (() => new Date());
	let pendingAgeMs = 0;
	const locked = await tryWithAdvisoryLock(
		options.pool,
		PUBLISHER_ADVISORY_LOCK_KEY,
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

/** Run until ECS sends SIGTERM or SIGINT. */
export async function runAgentCoreDispatchPublisher(
	options: PublisherLoopOptions,
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
