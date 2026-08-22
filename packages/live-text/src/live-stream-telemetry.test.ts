import { expect, it } from "bun:test";
import { createLiveStreamTelemetry } from "./live-stream-telemetry";

it("emits bounded payload-safe Live Stream operation metrics", () => {
	const events: Record<string, unknown>[] = [];
	const telemetry = createLiveStreamTelemetry("agentcore-runtime", {
		info: (event) => events.push(event),
		warn: (event) => events.push(event),
	});

	telemetry.record("publish", "success", { durationMs: 7 });
	telemetry.record("publish", "failure", {
		reason: "stream_bytes_exceeded",
		durationMs: 11,
	});
	telemetry.record("degradation", "ended", { durationMs: 1_250 });

	expect(events).toEqual([
		{
			message: "Live Stream metric",
			service: "agentcore-runtime",
			operation: "publish",
			result: "success",
			durationMs: 7,
			count: 1,
		},
		{
			message: "Live Stream metric",
			service: "agentcore-runtime",
			operation: "publish",
			result: "failure",
			reason: "stream_bytes_exceeded",
			durationMs: 11,
			count: 1,
		},
		{
			message: "Live Stream metric",
			service: "agentcore-runtime",
			operation: "degradation",
			result: "ended",
			durationMs: 1_250,
			count: 1,
		},
	]);
	const serialized = JSON.stringify(events);
	for (const forbidden of [
		"assistant text",
		"tool arguments",
		"runId",
		"messageId",
		"redis://",
		"mymemo:agui",
	]) {
		expect(serialized).not.toContain(forbidden);
	}
});

it("cannot let a failing metric logger affect Live Stream delivery", () => {
	const telemetry = createLiveStreamTelemetry("chat-api", {
		info() {
			throw new Error("logger unavailable");
		},
		warn() {
			throw new Error("logger unavailable");
		},
	});

	expect(() =>
		telemetry.record("reconnect_response", "retryable_503"),
	).not.toThrow();
});
