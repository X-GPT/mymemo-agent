import {
	createLiveTextTelemetry,
	createRedisLiveTextTransport,
	type LiveTextTelemetry,
	type LiveTextTransport,
	type RedisLiveTextSignal,
} from "@mymemo/live-text";
import type { LiveTextPreviewSignal } from "./sdk/live-text-preview";

interface LiveTextLogger {
	info(event: Record<string, unknown>): void;
	warn(event: Record<string, unknown>): void;
}

export function createWorkerLiveTextTelemetry(
	logger: LiveTextLogger,
): LiveTextTelemetry {
	return createLiveTextTelemetry("agent-worker", logger);
}

export function reportWorkerLiveTextPreviewSignal(
	telemetry: LiveTextTelemetry,
	signal: LiveTextPreviewSignal,
): void {
	if (signal.type === "attempted") {
		telemetry.record("attempted", "message_publication", "attempted");
		return;
	}
	if (signal.type === "delivered") {
		telemetry.record("delivered", "message_publication", "delivered");
		return;
	}
	if (signal.type === "recovered") {
		telemetry.recovered(
			signal.reason === "publisher_failure" ? "publisher" : "worker_queue",
		);
		return;
	}

	switch (signal.reason) {
		case "publisher_failure":
			telemetry.degraded("publisher");
			telemetry.record("dropped", "publisher", "dropped");
			break;
		case "queue_overflow":
			telemetry.degraded("worker_queue");
			telemetry.record("queue_overflow", "worker_queue", "dropped");
			break;
		case "mismatch":
			telemetry.record("dropped", "partial_complete", "dropped");
			break;
		case "run_aborted":
			telemetry.record("dropped", "run_aborted", "dropped");
			break;
		case "run_ended":
			telemetry.record("dropped", "run_ended", "dropped");
			break;
	}
}

/** Select the lazy production publisher only for validated Redis config. */
export function createWorkerLiveTextTransport(
	redisUrl: string | undefined,
	telemetry: LiveTextTelemetry,
): LiveTextTransport | undefined {
	if (redisUrl === undefined) {
		telemetry.disabled("configuration");
		return undefined;
	}
	return createRedisLiveTextTransport({
		url: redisUrl,
		onSignal: (signal: RedisLiveTextSignal) => {
			if (signal === "degraded") {
				telemetry.degraded("redis_connection");
			} else if (signal === "recovered") {
				telemetry.recovered("redis_connection");
			} else {
				telemetry.record("malformed", "adapter_message", "dropped");
			}
		},
	});
}
