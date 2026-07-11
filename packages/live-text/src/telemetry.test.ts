import { expect, it } from "bun:test";
import { createLiveTextTelemetry } from "./telemetry";

it("emits payload-free bounded signals and deduplicates state transitions", () => {
	const events: Record<string, unknown>[] = [];
	const telemetry = createLiveTextTelemetry("agent-worker", {
		info: (event) => events.push(event),
		warn: (event) => events.push(event),
	});

	telemetry.disabled("configuration");
	telemetry.disabled("configuration");
	telemetry.degraded("redis_connection");
	telemetry.degraded("redis_connection");
	telemetry.record("queue_overflow", "worker_queue", "dropped");
	telemetry.recovered("redis_connection");
	telemetry.recovered("redis_connection");

	expect(events).toEqual([
		{
			message: "Live preview signal",
			service: "agent-worker",
			signal: "disabled",
			reason: "configuration",
			count: 1,
		},
		{
			message: "Live preview signal",
			service: "agent-worker",
			signal: "degraded",
			reason: "redis_connection",
			count: 1,
		},
		{
			message: "Live preview signal",
			service: "agent-worker",
			signal: "queue_overflow",
			reason: "worker_queue",
			outcome: "dropped",
			count: 1,
		},
		{
			message: "Live preview signal",
			service: "agent-worker",
			signal: "recovered",
			reason: "redis_connection",
			count: 1,
		},
	]);
	expect(JSON.stringify(events)).not.toContain("text");
	expect(JSON.stringify(events)).not.toContain("runId");
	expect(JSON.stringify(events)).not.toContain("messageId");
});

it("cannot let a failing logger affect Live delivery", () => {
	const telemetry = createLiveTextTelemetry("chat-api", {
		info() {
			throw new Error("logger unavailable");
		},
		warn() {
			throw new Error("logger unavailable");
		},
	});

	expect(() => {
		telemetry.degraded("subscription");
		telemetry.record("gap_detected", "delta_gap", "dropped");
		telemetry.recovered("subscription");
	}).not.toThrow();
});
