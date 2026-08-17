import type { PublisherLogger } from "./logger";
import { toMessage } from "./logger";

const namespace = "MyMemo/AgentCoreDispatch";

function publisherMetricEnvelope(
	metrics: Array<{ Name: string; Unit: "Count" | "Milliseconds" }>,
) {
	return {
		message: "AgentCore dispatch publisher metric",
		_aws: {
			Timestamp: Date.now(),
			CloudWatchMetrics: [
				{ Namespace: namespace, Dimensions: [[]], Metrics: metrics },
			],
		},
	};
}

export function recordPublisherLostLock(logger: PublisherLogger): void {
	logger.info({
		...publisherMetricEnvelope([{ Name: "PublisherLostLock", Unit: "Count" }]),
		outcome: "lost_lock",
		PublisherLostLock: 1,
	});
}

export function recordPublisherTickFailure(
	logger: PublisherLogger,
	error: unknown,
	pendingAgeMs?: number,
): void {
	const metrics: Array<{ Name: string; Unit: "Count" | "Milliseconds" }> = [
		{ Name: "PublisherErrors", Unit: "Count" },
	];
	if (pendingAgeMs !== undefined) {
		metrics.push({ Name: "PendingAgeMs", Unit: "Milliseconds" });
	}
	logger.error({
		...publisherMetricEnvelope(metrics),
		outcome: "error",
		reason: "tick_failed",
		error: toMessage(error),
		...(pendingAgeMs === undefined ? {} : { PendingAgeMs: pendingAgeMs }),
		PublisherErrors: 1,
	});
}

export function recordPublisherPublication(
	logger: PublisherLogger,
	result: {
		status: "enabled" | "disabled";
		ambiguousRunIds: readonly string[];
	},
	pendingAgeMs: number,
): void {
	if (result.ambiguousRunIds.length > 0) {
		logger.error({
			...publisherMetricEnvelope([
				{ Name: "PublisherErrors", Unit: "Count" },
				{ Name: "PendingAgeMs", Unit: "Milliseconds" },
			]),
			outcome: "error",
			reason: "ambiguous_send",
			ambiguousCount: result.ambiguousRunIds.length,
			PendingAgeMs: pendingAgeMs,
			PublisherErrors: 1,
		});
		return;
	}

	logger.info({
		...publisherMetricEnvelope([
			{ Name: "PendingAgeMs", Unit: "Milliseconds" },
		]),
		outcome: result.status === "disabled" ? "disabled" : "published",
		PendingAgeMs: pendingAgeMs,
	});
}
