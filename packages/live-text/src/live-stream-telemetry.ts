export type LiveStreamService = "agent-worker" | "chat-api";

export type LiveStreamOperation =
	| "acquire"
	| "append"
	| "degradation"
	| "finalize"
	| "read_wait"
	| "reconnect_response"
	| "recovery_response"
	| "refresh";

export type LiveStreamResult =
	| "aborted"
	| "consumer"
	| "ended"
	| "failure"
	| "finalized"
	| "history_410"
	| "producer"
	| "retry"
	| "retryable_503"
	| "started"
	| "success";

export type LiveStreamReason =
	| "append_retry_conflict"
	| "event_too_large"
	| "finalize_conflict"
	| "finalized"
	| "invalid_cursor"
	| "invalid_event"
	| "marker_write_failed"
	| "missing"
	| "not_producer"
	| "operation_failed"
	| "redis_unavailable"
	| "stale_worker"
	| "stream_bytes_exceeded"
	| "stream_events_exceeded";

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
