import { expect, it } from "bun:test";
import { createLiveTextTelemetry } from "@mymemo/live-text";
import {
	reportChatLiveTextProjectionSignal,
	reportChatLiveTextRuntimeSignal,
	reportChatLiveTextSetupSignal,
} from "./live-text-telemetry";

it("maps every chat-api Live degradation path to bounded payload-free signals", () => {
	const events: Record<string, unknown>[] = [];
	const telemetry = createLiveTextTelemetry("chat-api", {
		info: (event) => events.push(event),
		warn: (event) => events.push(event),
	});

	reportChatLiveTextRuntimeSignal(telemetry, "disabled");
	reportChatLiveTextRuntimeSignal(telemetry, "degraded");
	reportChatLiveTextRuntimeSignal(telemetry, "recovered");
	reportChatLiveTextRuntimeSignal(telemetry, "invalid_message");
	reportChatLiveTextSetupSignal(telemetry, "subscription_timeout");
	for (const signal of [
		"message_attempted",
		"message_delivered",
		"message_dropped",
		"gap",
		"malformed_message",
		"queue_overflow",
		"slow_client",
		"partial_complete_mismatch",
		"impossible_ordering",
	] as const) {
		reportChatLiveTextProjectionSignal(telemetry, signal);
	}

	expect(events.map(({ signal }) => signal)).toEqual([
		"disabled",
		"degraded",
		"recovered",
		"malformed",
		"dropped",
		"attempted",
		"delivered",
		"dropped",
		"gap_detected",
		"malformed",
		"queue_overflow",
		"slow_client",
		"mismatch",
		"impossible_ordering",
	]);
	expect(events.every(({ service }) => service === "chat-api")).toBe(true);
	expect(JSON.stringify(events)).not.toContain("preview text");
	expect(JSON.stringify(events)).not.toContain("run-1");
	expect(JSON.stringify(events)).not.toContain("message-1");
});
