import { expect, it } from "bun:test";
import {
	createWorkerLiveTextTelemetry,
	createWorkerLiveTextTransport,
	reportWorkerLiveTextPreviewSignal,
	reportWorkerLiveTextRuntimeSignal,
} from "./live-text";

const logger = {
	info() {},
	warn() {},
};

it("keeps the worker Live lane disabled without valid Redis configuration", () => {
	const signals: unknown[] = [];
	const recordingLogger = {
		info(event: unknown) {
			signals.push(event);
		},
		warn() {},
	};
	expect(
		createWorkerLiveTextTransport(
			undefined,
			createWorkerLiveTextTelemetry(recordingLogger),
		),
	).toBeUndefined();
	expect(signals).toEqual([
		{
			message: "Live preview signal",
			service: "agent-worker",
			signal: "disabled",
			reason: "configuration",
			count: 1,
		},
	]);
});

it("constructs the lazy production publisher when Redis is configured", async () => {
	const transport = createWorkerLiveTextTransport(
		"rediss://default:secret@redis.internal:6379",
		createWorkerLiveTextTelemetry(logger),
	);
	expect(transport).toBeDefined();
	await transport?.close();
});

it("maps every worker Live path to bounded payload-free signals", () => {
	const events: Record<string, unknown>[] = [];
	const telemetry = createWorkerLiveTextTelemetry({
		info: (event) => events.push(event),
		warn: (event) => events.push(event),
	});

	for (const signal of [
		"degraded",
		"recovered",
		"invalid_message",
		"oversized_message",
	] as const) {
		reportWorkerLiveTextRuntimeSignal(telemetry, signal);
	}
	for (const signal of [
		{ type: "attempted" },
		{ type: "delivered" },
		{ type: "dropped", reason: "publisher_failure" },
		{ type: "dropped", reason: "queue_overflow" },
		{ type: "dropped", reason: "mismatch" },
		{ type: "dropped", reason: "run_aborted" },
		{ type: "dropped", reason: "run_ended" },
		{ type: "recovered", reason: "publisher_failure" },
		{ type: "recovered", reason: "queue_overflow" },
	] as const) {
		reportWorkerLiveTextPreviewSignal(telemetry, signal);
	}

	expect(
		events.map(({ signal, reason, outcome }) => ({ signal, reason, outcome })),
	).toEqual([
		{ signal: "degraded", reason: "redis_connection", outcome: undefined },
		{ signal: "recovered", reason: "redis_connection", outcome: undefined },
		{ signal: "malformed", reason: "adapter_message", outcome: "dropped" },
		{ signal: "malformed", reason: "adapter_message", outcome: "dropped" },
		{
			signal: "attempted",
			reason: "message_publication",
			outcome: "attempted",
		},
		{
			signal: "delivered",
			reason: "message_publication",
			outcome: "delivered",
		},
		{ signal: "dropped", reason: "publisher", outcome: "dropped" },
		{ signal: "queue_overflow", reason: "worker_queue", outcome: "dropped" },
		{ signal: "dropped", reason: "partial_complete", outcome: "dropped" },
		{ signal: "dropped", reason: "run_aborted", outcome: "dropped" },
		{ signal: "dropped", reason: "run_ended", outcome: "dropped" },
		{ signal: "recovered", reason: "publisher", outcome: undefined },
		{ signal: "recovered", reason: "worker_queue", outcome: undefined },
	]);
	expect(events.every(({ service }) => service === "agent-worker")).toBe(true);
	expect(JSON.stringify(events)).not.toContain("preview text");
	expect(JSON.stringify(events)).not.toContain("run-1");
	expect(JSON.stringify(events)).not.toContain("message-1");
	telemetry.close();
});
