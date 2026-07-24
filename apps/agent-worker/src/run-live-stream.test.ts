import { expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import {
	createInMemoryLiveStreamRelay,
	decodeAgUiLiveStreamEvent,
	type LiveStreamMetricEvent,
	type LiveStreamRelayOptions,
	type LiveStreamTelemetry,
} from "@mymemo/live-text";
import type { WorkerLogger } from "./logger";
import { RunLiveStream } from "./run-live-stream";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

it("publishes RUN_STARTED through the terminal event over one relay producer", async () => {
	const relay = createInMemoryLiveStreamRelay();
	const stream = await RunLiveStream.open({
		relay,
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			throw new Error("must not mark a healthy Stream");
		},
		logger: silentLogger,
	});
	const attached = await relay.attach("run-1", new AbortController().signal);
	expect(attached.outcome).toBe("attached");
	if (attached.outcome !== "attached") throw new Error("expected attachment");

	await stream.finish("done");
	const events = [];
	for await (const event of attached.events) {
		events.push(decodeAgUiLiveStreamEvent(event));
	}

	expect(events).toEqual([
		{ type: EventType.RUN_STARTED, threadId: "conv-1", runId: "run-1" },
		{ type: EventType.RUN_FINISHED, threadId: "conv-1", runId: "run-1" },
	]);
	const afterClose = await relay.attach("run-1", new AbortController().signal);
	expect(afterClose.outcome).toBe("no_producer");
	await relay.close();
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
	const relay = createInMemoryLiveStreamRelay({
		telemetry,
		testHooks: {
			failEventPublishWhen: ({ eventType }) =>
				eventType === EventType.RUN_STARTED,
		},
	});
	const stream = await RunLiveStream.open({
		relay,
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

	expect(metrics).toContainEqual(
		expect.objectContaining({
			operation: "publish",
			result: "failure",
			reason: "redis_unavailable",
		}),
	);
	expect(metrics).toContainEqual(
		expect.objectContaining({
			operation: "degradation",
			result: "started",
			reason: "relay_failed",
		}),
	);
	expect(metrics).toContainEqual(
		expect.objectContaining({
			operation: "degradation",
			result: "ended",
			reason: "relay_failed",
			durationMs: expect.any(Number),
		}),
	);
	expect(logs).toEqual([
		{
			message: "Live Stream publication disabled",
			runId: "run-1",
			reason: "relay_failed",
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
	await relay.close();
});

it("retries a transient Live Stream failure-marker write after the Run terminalizes", async () => {
	let markerAttempts = 0;
	const relay = createInMemoryLiveStreamRelay({
		testHooks: {
			failEventPublishWhen: ({ eventType }) =>
				eventType === EventType.RUN_STARTED,
		},
	});
	const stream = await RunLiveStream.open({
		relay,
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
	await relay.close();
});

it.each([
	[
		"terminal publish",
		{
			failEventPublishWhen: ({ terminal }) => terminal,
		} satisfies NonNullable<LiveStreamRelayOptions["testHooks"]>,
		undefined,
	],
	["buffer overflow", undefined, { maxEvents: 1 }],
] as const)("latches %s failure while the Run still reaches its durable outcome", async (_name, testHooks, testLimits) => {
	let markerAttempts = 0;
	const relay = createInMemoryLiveStreamRelay({
		...(testHooks ? { testHooks } : {}),
		...(testLimits ? { testLimits } : {}),
	});
	const stream = await RunLiveStream.open({
		relay,
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			markerAttempts += 1;
			return { outcome: "marked", failedAt: new Date() };
		},
		logger: silentLogger,
	});

	if (testLimits) {
		await stream.append({
			type: EventType.TEXT_MESSAGE_START,
			messageId: "assistant-1",
			role: "assistant",
		});
	}
	await stream.finish("done");

	expect(markerAttempts).toBe(1);
	await relay.close();
});
