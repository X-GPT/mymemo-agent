import { expect, it } from "bun:test";
import type {
	LiveStreamMetricEvent,
	LiveStreamTelemetry,
} from "@mymemo/live-text";
import type { WorkerLogger } from "./logger";
import { RunLiveStream } from "./run-live-stream";
import { fakeLiveStreamStore } from "./testing/live-stream-store";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

it("measures healthy producer acquisition, publication, refresh, and finalization", async () => {
	const metrics: Array<Record<string, unknown>> = [];
	const stream = await RunLiveStream.open({
		store: fakeLiveStreamStore(),
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			throw new Error("must not mark a healthy Stream");
		},
		logger: silentLogger,
		telemetry: {
			record(operation, result, options) {
				metrics.push({ operation, result, ...options });
			},
		},
	});

	await stream.refresh();
	await stream.finish("done");

	expect(metrics).toEqual([
		expect.objectContaining({
			operation: "acquire",
			result: "producer",
			durationMs: expect.any(Number),
		}),
		expect.objectContaining({
			operation: "append",
			result: "success",
			durationMs: expect.any(Number),
		}),
		expect.objectContaining({
			operation: "refresh",
			result: "success",
			durationMs: expect.any(Number),
		}),
		expect.objectContaining({
			operation: "append",
			result: "success",
			durationMs: expect.any(Number),
		}),
		expect.objectContaining({
			operation: "finalize",
			result: "success",
			durationMs: expect.any(Number),
		}),
	]);
});

it("observes a payload-safe degradation transition separately from Run outcome", async () => {
	const logs: Record<string, unknown>[] = [];
	const metrics: LiveStreamMetricEvent[] = [];
	const logger: WorkerLogger = {
		info: (event) => logs.push(event),
		warn: (event) => logs.push(event),
		error: (event) => logs.push(event),
	};
	const telemetry: LiveStreamTelemetry = {
		record(operation, result, options) {
			metrics.push({
				message: "Live Stream metric",
				service: "agent-worker",
				operation,
				result,
				...options,
				count: 1,
			});
		},
	};
	const stream = await RunLiveStream.open({
		store: fakeLiveStreamStore({
			async append() {
				throw new Error(
					"redis://:secret@redis.internal current:mymemo:agui:{run-1}:stream assistant text tool arguments",
				);
			},
		}),
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			return {
				outcome: "marked" as const,
				failedAt: new Date(Date.now() - 1_000),
			};
		},
		logger,
		telemetry,
	});

	await stream.finish("done");

	expect(metrics).toEqual([
		expect.objectContaining({
			operation: "acquire",
			result: "producer",
			durationMs: expect.any(Number),
		}),
		expect.objectContaining({
			operation: "append",
			result: "failure",
			reason: "redis_unavailable",
			durationMs: expect.any(Number),
		}),
		expect.objectContaining({
			operation: "degradation",
			result: "started",
			reason: "redis_unavailable",
		}),
		expect.objectContaining({
			operation: "finalize",
			result: "success",
			durationMs: expect.any(Number),
		}),
		expect.objectContaining({
			operation: "degradation",
			result: "ended",
			reason: "redis_unavailable",
			durationMs: expect.any(Number),
		}),
	]);
	expect(logs).toEqual([
		{
			message: "Live Stream publication disabled",
			runId: "run-1",
			reason: "redis_unavailable",
		},
	]);
	const serialized = JSON.stringify({ logs, metrics });
	for (const forbidden of [
		"assistant text",
		"tool arguments",
		"redis://",
		"secret",
		"mymemo:agui",
		"conv-1",
	]) {
		expect(serialized).not.toContain(forbidden);
	}
});

it("retries a transient Live Stream failure-marker write after the Run terminalizes", async () => {
	let markerAttempts = 0;
	const stream = await RunLiveStream.open({
		store: fakeLiveStreamStore({
			async append() {
				throw new Error("Redis unavailable");
			},
		}),
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			markerAttempts += 1;
			if (markerAttempts === 1) throw new Error("database unavailable");
			return { outcome: "marked", failedAt: new Date() };
		},
		logger: silentLogger,
	});

	expect(markerAttempts).toBe(1);
	await stream.finish("done");
	expect(markerAttempts).toBe(2);
});

it.each([
	"append",
	"finalization",
] as const)("retries a transient failure-marker write after terminal %s fails", async (fault) => {
	let appendAttempts = 0;
	let finalizeAttempts = 0;
	let markerAttempts = 0;
	const stream = await RunLiveStream.open({
		store: fakeLiveStreamStore({
			async append() {
				appendAttempts += 1;
				if (fault === "append" && appendAttempts === 2) {
					throw new Error("Redis unavailable");
				}
			},
			async finalize() {
				finalizeAttempts += 1;
				if (fault === "finalization" && finalizeAttempts === 1) {
					throw new Error("Redis unavailable");
				}
			},
		}),
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			markerAttempts += 1;
			if (markerAttempts === 1) throw new Error("database unavailable");
			return { outcome: "marked", failedAt: new Date() };
		},
		logger: silentLogger,
	});

	await stream.finish("done");
	expect(markerAttempts).toBe(2);
});
