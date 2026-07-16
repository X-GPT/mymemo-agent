import {
	type LiveTextTelemetry,
	type RedisLiveTextSignal,
	reportRedisLiveTextSignal,
} from "@mymemo/live-text";
import type { LiveTextSetupSignal } from "./prepare-live-text-subscription";
import type { ProjectRunLiveTextSignal } from "./project-run";

export function reportChatLiveTextRuntimeSignal(
	telemetry: LiveTextTelemetry,
	signal: RedisLiveTextSignal | "disabled",
): void {
	if (signal === "disabled") {
		telemetry.disabled("configuration");
		return;
	}
	reportRedisLiveTextSignal(telemetry, signal);
}

export function reportChatLiveTextSetupSignal(
	telemetry: LiveTextTelemetry,
	signal: LiveTextSetupSignal,
): void {
	if (signal === "disabled") {
		telemetry.disabled("configuration");
	} else if (signal === "subscription_timeout") {
		telemetry.record("dropped", "subscription_timeout");
	} else if (signal === "subscription_failure") {
		telemetry.record("dropped", "subscription");
	}
}

export function reportChatLiveTextProjectionSignal(
	telemetry: LiveTextTelemetry,
	signal: ProjectRunLiveTextSignal,
): void {
	switch (signal) {
		case "message_attempted":
			telemetry.record("attempted", "message_projection", "attempted");
			break;
		case "message_delivered":
			telemetry.record("delivered", "message_projection", "delivered");
			break;
		case "message_dropped":
			telemetry.record("dropped", "message_projection", "dropped");
			break;
		case "gap":
			telemetry.record("gap_detected", "delta_gap");
			break;
		case "malformed_message":
			telemetry.record("malformed", "adapter_message");
			break;
		case "queue_overflow":
			telemetry.record("queue_overflow", "connection_buffer");
			break;
		case "reconciliation_overflow":
			telemetry.record("queue_overflow", "reconciliation_state");
			break;
		case "slow_client":
			telemetry.record("slow_client", "connection_buffer");
			break;
		case "partial_complete_mismatch":
			telemetry.record("mismatch", "partial_complete");
			break;
		case "subscriber_failure":
			telemetry.record("dropped", "subscription");
			break;
		case "duplicate_inconsistency":
			telemetry.record("impossible_ordering", "duplicate_delta");
			break;
		case "late_delta":
			telemetry.record("impossible_ordering", "late_delta");
			break;
		case "terminal_open_preview":
			telemetry.record("impossible_ordering", "terminal_preview");
			break;
		case "impossible_ordering":
			telemetry.record("impossible_ordering", "transport_channel");
			break;
	}
}
