import type { PublisherLogger } from "./logger";
import { toMessage } from "./logger";

const namespace = "MyMemo/AgentCoreDispatch";

function embeddedMetrics(
	metrics: Array<{ Name: string; Unit: "Count" | "Milliseconds" }>,
) {
	return {
		Timestamp: Date.now(),
		CloudWatchMetrics: [
			{ Namespace: namespace, Dimensions: [[]], Metrics: metrics },
		],
	};
}

export function recordPublisherLostLock(logger: PublisherLogger): void {
	logger.info({
		message: "AgentCore dispatch publisher metric",
		outcome: "lost_lock",
		PublisherLostLock: 1,
		_aws: embeddedMetrics([{ Name: "PublisherLostLock", Unit: "Count" }]),
	});
}

export function recordPublisherTickFailure(
	logger: PublisherLogger,
	error: unknown,
): void {
	logger.error({
		message: "AgentCore dispatch publisher metric",
		outcome: "error",
		reason: "tick_failed",
		error: toMessage(error),
		PendingAgeMs: 0,
		PublisherErrors: 1,
		_aws: embeddedMetrics([
			{ Name: "PublisherErrors", Unit: "Count" },
			{ Name: "PendingAgeMs", Unit: "Milliseconds" },
		]),
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
			message: "AgentCore dispatch publisher metric",
			outcome: "error",
			reason: "ambiguous_send",
			ambiguousCount: result.ambiguousRunIds.length,
			PendingAgeMs: pendingAgeMs,
			PublisherErrors: 1,
			_aws: embeddedMetrics([
				{ Name: "PublisherErrors", Unit: "Count" },
				{ Name: "PendingAgeMs", Unit: "Milliseconds" },
			]),
		});
		return;
	}

	logger.info({
		message: "AgentCore dispatch publisher metric",
		outcome: result.status === "disabled" ? "disabled" : "published",
		PendingAgeMs: pendingAgeMs,
		_aws: embeddedMetrics([{ Name: "PendingAgeMs", Unit: "Milliseconds" }]),
	});
}
