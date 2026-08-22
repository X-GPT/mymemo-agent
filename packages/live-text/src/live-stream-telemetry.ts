export type LiveStreamService = "agentcore-runtime" | "chat-api";

export type LiveStreamOperation =
	| "attach_attempt"
	| "backlog_request"
	| "degradation"
	| "publish"
	| "reconnect_response"
	| "recovery_response";

export type LiveStreamResult =
	| "aborted"
	| "ended"
	| "failure"
	| "history_410"
	| "no_producer"
	| "retry"
	| "retryable_503"
	| "started"
	| "success";

export type LiveStreamReason =
	| "event_too_large"
	| "invalid_event"
	| "marker_write_failed"
	| "producer_closed"
	| "producer_failed"
	| "relay_closed"
	| "relay_failed"
	| "redis_unavailable"
	| "stale_worker"
	| "stream_bytes_exceeded"
	| "stream_events_exceeded"
	| "terminal_already_published"
	| "terminal_not_allowed"
	| "terminal_required";

export interface LiveStreamMetricEvent extends Record<string, unknown> {
	message: "Live Stream metric";
	service: LiveStreamService;
	operation: LiveStreamOperation;
	result: LiveStreamResult;
	reason?: LiveStreamReason;
	durationMs?: number;
	count: 1;
}

interface LiveStreamTelemetryLogger {
	info(event: LiveStreamMetricEvent): void;
	warn(event: LiveStreamMetricEvent): void;
}

export interface LiveStreamTelemetry {
	record(
		operation: LiveStreamOperation,
		result: LiveStreamResult,
		options?: { reason?: LiveStreamReason; durationMs?: number },
	): void;
}

/**
 * Emits one cardinality-bounded metric event. The API deliberately accepts no
 * identifiers, payloads, Redis keys, URLs, or thrown errors.
 */
export function createLiveStreamTelemetry(
	service: LiveStreamService,
	logger: LiveStreamTelemetryLogger,
): LiveStreamTelemetry {
	return {
		record(operation, result, options = {}) {
			const event: LiveStreamMetricEvent = {
				message: "Live Stream metric",
				service,
				operation,
				result,
				...(options.reason ? { reason: options.reason } : {}),
				...(options.durationMs === undefined
					? {}
					: { durationMs: Math.max(0, Math.round(options.durationMs)) }),
				count: 1,
			};
			try {
				if (result === "failure" || result === "retryable_503") {
					logger.warn(event);
				} else {
					logger.info(event);
				}
			} catch {
				// Observability must never change Live Stream delivery or Run execution.
			}
		},
	};
}

export const disabledLiveStreamTelemetry: LiveStreamTelemetry = {
	record() {},
};
