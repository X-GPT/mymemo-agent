import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import {
	appendRunEventTx,
	claimNextRunTx,
	createQueuedRunTx,
	RunFenceError,
	requestRunInterruptionTx,
} from "@mymemo/agent-db/run-store";
import {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
} from "@mymemo/agent-db/runtime-store";
import {
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import {
	createInMemoryLiveStreamRelay,
	decodeAgUiLiveStreamEvent,
	type LiveStreamRelay,
	type LiveStreamTelemetry,
} from "@mymemo/live-text";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "./logger";
import { RunLoop, type RunProcessor } from "./run-loop";
import { Worker } from "./worker";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
});

/** A promise whose resolution the test controls, to gate a processor. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function buildWorker(maxConcurrentRuns: number, workerId = "worker-1") {
	return new Worker({
		workerId,
		maxConcurrentRuns,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
}

function buildLoop(
	worker: Worker,
	processor: RunProcessor,
	liveStreamRelay: LiveStreamRelay = createInMemoryLiveStreamRelay(),
	liveStreamTelemetry?: LiveStreamTelemetry,
) {
	return new RunLoop({
		db: tdb.db,
		worker,
		processor,
		liveStreamRelay,
		liveStreamTelemetry,
		heartbeatIntervalMs: 15_000,
		logger: silentLogger,
	});
}

async function queueRun(runId: string, conversationId: string) {
	await tdb.db
		.insert(conversations)
		.values({ userId: "user-1", conversationId, scope: "general" })
		.onConflictDoNothing();
	await createQueuedRunTx(tdb.db, { runId, userId: "user-1", conversationId });
}

async function claimRun(
	runId: string,
	conversationId: string,
	workerId: string,
) {
	await queueRun(runId, conversationId);
	const claimed = await claimNextRunTx(tdb.db, { workerId });
	if (claimed?.runId !== runId) {
		throw new Error(`test setup claimed ${claimed?.runId}, wanted ${runId}`);
	}
	return claimed;
}

async function expireOwnership(runId: string) {
	await tdb.db
		.update(runs)
		.set({ lockedUntil: sql`now() - interval '1 second'` })
		.where(eq(runs.runId, runId));
}

async function readRun(runId: string) {
	const [row] = await tdb.db.select().from(runs).where(eq(runs.runId, runId));
	return row;
}

async function readEventTypes(runId: string) {
	const rows = await tdb.db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(runEvents.seq);
	return rows.map((e) => e.type);
}

/** Appends one complete Assistant message then returns. */
const appendMessageProcessor: RunProcessor = async (ctx) => {
	await ctx.appendModelContent({
		kind: "assistant_message",
		payload: {
			messageId: `message-${ctx.run.runId}`,
			text: `synthetic ${ctx.run.runId}`,
		},
	});
};

async function readRuntime(conversationId: string) {
	return loadConversationRuntimeTx(tdb.db, {
		userId: "user-1",
		conversationId,
	});
}

describe("RunLoop — concurrency", () => {
	it("claims at most the configured concurrency in one tick", async () => {
		const worker = buildWorker(1);
		// Block processing so a claimed run stays active across the assertions.
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-2");

		const claimed = await loop.tick();

		expect(claimed).toBe(1);
		expect(worker.activeCount).toBe(1);
		// The second run is left queued for a later tick / another worker.
		expect((await readRun("run-2"))?.status).toBe("queued");

		gate.resolve();
		await worker.drain();
	});

	it("claims the next run once a slot frees", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-2");

		expect(await loop.tick()).toBe(1);
		await worker.drain();
		expect(await loop.tick()).toBe(1);
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect((await readRun("run-2"))?.status).toBe("done");
	});
});

describe("RunLoop — claim isolation", () => {
	it("never hands the same run to two workers", async () => {
		const workerA = buildWorker(2, "worker-a");
		const workerB = buildWorker(2, "worker-b");
		const gate = deferred();
		const block: RunProcessor = async () => {
			await gate.promise;
		};
		const loopA = buildLoop(workerA, block);
		const loopB = new RunLoop({
			db: tdb.db,
			worker: workerB,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: block,
			heartbeatIntervalMs: 15_000,
			logger: silentLogger,
		});
		await queueRun("run-1", "conv-1");

		const claimedA = await loopA.tick();
		const claimedB = await loopB.tick();

		expect(claimedA).toBe(1);
		expect(claimedB).toBe(0);
		expect((await readRun("run-1"))?.lockedBy).toBe("worker-a");

		gate.resolve();
		await workerA.drain();
		await workerB.drain();
	});
});

describe("RunLoop — heartbeat", () => {
	it("renews the lock deadline for a run it owns", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)

		// Pull the deadline near expiry so the fixed-duration renewal is visible.
		await tdb.db
			.update(runs)
			.set({ lockedUntil: sql`now() + interval '1 second'` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeats the active run

		const row = await readRun("run-1");
		expect(row?.lockedBy).toBe("worker-1");
		expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now() + 30_000);

		gate.resolve();
		await worker.drain();
	});

	it("abandons a run whose ownership it lost without terminalizing it", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		// A processor that ignores the abort signal — proves abandonment does not
		// depend on the processor cooperating.
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)

		// Another worker steals the run: the heartbeat fence (locked_by = us) is
		// now rejected, so heartbeatRunTx returns null.
		await tdb.db
			.update(runs)
			.set({
				lockedBy: "worker-2",
				lockedUntil: sql`now() + interval '60 seconds'`,
			})
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeat observes the lost fence → abandons
		gate.resolve();
		await worker.drain();

		// We must not terminalize a run we no longer own: no terminal event from
		// us, and the thief's ownership is untouched (recovery is its problem now).
		const row = await readRun("run-1");
		expect(row?.status).toBe("running");
		expect(row?.lockedBy).toBe("worker-2");
		expect(await readEventTypes("run-1")).toEqual([]);
	});
});

describe("RunLoop — terminal outcomes", () => {
	it("marks the Live Stream failed and continues when the relay cannot open a producer", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		await liveStreamRelay.close();
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "assistant-1",
					delta: "not published",
				});
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "assistant-1", text: "still durable" },
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("commits durable facts before exposing AG-UI completion events", async () => {
		const observed: unknown[] = [];
		const processorStarted = deferred();
		const continueProcessor = deferred();
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				processorStarted.resolve();
				await continueProcessor.promise;
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_START,
					messageId: "assistant-1",
					role: "assistant",
				});
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "assistant-1",
					delta: "hello",
				});
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "assistant-1", text: "hello" },
				});
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_END,
					messageId: "assistant-1",
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await processorStarted.promise;
		const attached = await liveStreamRelay.attach(
			"run-1",
			new AbortController().signal,
		);
		if (attached.outcome !== "attached") throw new Error("expected attachment");
		const consume = (async () => {
			for await (const chunk of attached.events) {
				const event = decodeAgUiLiveStreamEvent(chunk);
				if (event.type === EventType.TEXT_MESSAGE_END) {
					expect(await readEventTypes("run-1")).toContain(
						"assistant_message_completed",
					);
				}
				if (event.type === EventType.RUN_FINISHED) {
					expect((await readRun("run-1"))?.status).toBe("done");
				}
				observed.push(event);
			}
		})();

		continueProcessor.resolve();
		await worker.drain();
		await consume;

		expect(observed).toEqual([
			{ type: EventType.RUN_STARTED, threadId: "conv-1", runId: "run-1" },
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: "assistant-1",
				role: "assistant",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "assistant-1",
				delta: "hello",
			},
			{ type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
			{ type: EventType.RUN_FINISHED, threadId: "conv-1", runId: "run-1" },
		]);
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("continues durable execution after a mid-text Live Stream write fails", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ eventType }) =>
					eventType === EventType.TEXT_MESSAGE_CONTENT,
			},
		});
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_START,
					messageId: "assistant-1",
					role: "assistant",
				});
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "assistant-1",
					delta: "still durable",
				});
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: {
						messageId: "assistant-1",
						text: "still durable",
					},
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("keeps committing Tool events after Live Stream publication fails", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ eventType }) =>
					eventType === EventType.TOOL_CALL_START,
			},
		});
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "assistant-1", text: "" },
				});
				await ctx.appendModelContents([
					{
						kind: "tool_call_started",
						payload: {
							toolCallId: "tool-1",
							toolCallName: "Bash",
							parentMessageId: "assistant-1",
						},
					},
					{
						kind: "tool_call_args",
						payload: { toolCallId: "tool-1", delta: '{"command":"pwd"}' },
					},
					{
						kind: "tool_call_completed",
						payload: { toolCallId: "tool-1" },
					},
				]);
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_START,
					toolCallId: "tool-1",
					toolCallName: "Bash",
					parentMessageId: "assistant-1",
				});
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_ARGS,
					toolCallId: "tool-1",
					delta: '{"command":"pwd"}',
				});
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_END,
					toolCallId: "tool-1",
				});
				await ctx.appendModelContent({
					kind: "tool_call_result",
					payload: {
						messageId: "tool-result-1",
						toolCallId: "tool-1",
						content: '{"exitCode":0}',
						isError: false,
					},
				});
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_RESULT,
					messageId: "tool-result-1",
					toolCallId: "tool-1",
					content: '{"exitCode":0}',
					role: "tool",
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
			"run_done",
		]);
	});

	it("marks the Live Stream failed after durable terminalization without changing the Outcome", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ terminal }) => terminal,
			},
		});
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor, liveStreamRelay);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("ends a synthetic run as done with one durable Assistant message", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
		const [message] = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.type, "assistant_message_completed"));
		expect(message?.payload).toEqual({
			messageId: "message-run-1",
			text: "synthetic run-1",
		});
	});

	it("logs a failed run but persists only a generic client message", async () => {
		const worker = buildWorker(1);
		const errors: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			...silentLogger,
			error(event) {
				errors.push(event);
			},
		};
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: async () => {
				throw new Error("provider leaked a secret detail");
			},
			heartbeatIntervalMs: 15_000,
			logger,
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		const row = await readRun("run-1");
		expect(row?.status).toBe("error");
		const [event] = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"));
		expect(event?.type).toBe("run_error");
		expect((event?.payload as { message?: string })?.message).toBe(
			"Run failed",
		);
		expect(JSON.stringify(event?.payload)).not.toContain("secret detail");
		expect(errors).toContainEqual({
			message: "run failed",
			workerId: "worker-1",
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
			error: "provider leaked a secret detail",
		});
	});

	it("terminalizes as interrupted when interruption is observed mid-processing", async () => {
		const worker = buildWorker(1);
		const published: unknown[] = [];
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		const processorStarted = deferred();
		// A processor that runs until the run is aborted, without appending.
		const loop = buildLoop(
			worker,
			async (ctx) => {
				processorStarted.resolve();
				await new Promise<void>((resolve) => {
					if (ctx.signal.aborted) return resolve();
					ctx.signal.addEventListener("abort", () => resolve(), { once: true });
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor now blocking on abort)
		await processorStarted.promise;
		const attached = await liveStreamRelay.attach(
			"run-1",
			new AbortController().signal,
		);
		if (attached.outcome !== "attached") throw new Error("expected attachment");
		const consume = (async () => {
			for await (const chunk of attached.events) {
				published.push(decodeAgUiLiveStreamEvent(chunk));
			}
		})();

		// User requests interruption while the run is executing.
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested", interruptRequestedAt: sql`now()` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeat observes interrupt_requested → aborts the run
		await worker.drain();
		await consume;

		expect(await readRun("run-1")).toMatchObject({
			status: "interrupted",
			liveStreamFailedAt: null,
		});
		expect(await readEventTypes("run-1")).toEqual(["run_interrupted"]);
		expect(published).toEqual([
			{ type: EventType.RUN_STARTED, threadId: "conv-1", runId: "run-1" },
			{ type: "RUN_INTERRUPTED", threadId: "conv-1", runId: "run-1" },
		]);
	});
});

describe("RunLoop — agent session pointer", () => {
	it("advances the resume pointer on a successful turn that reports a session", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			// The runtime row is created while the run is owned (as E2B provisioning
			// will), so the fenced pointer advance in `finish()` has a row to update.
			await createConversationRuntimeTx(tdb.db, {
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
				runId: ctx.run.runId,
				workerId: "worker-1",
			});
			return {
				disposition: "completed",
				streamMetadata: {
					sessionId: "session-abc",
					mirrorErrorObserved: false,
					mirrorErrorCategory: null,
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readRuntime("conv-1")).toMatchObject({
			agentSessionId: "session-abc",
		});
	});

	it("terminalizes error without establishing a pointer after a mirror error stop", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
				runId: ctx.run.runId,
				workerId: "worker-1",
			});
			return {
				disposition: "stopped",
				streamMetadata: {
					sessionId: "session-unreliable",
					mirrorErrorObserved: true,
					mirrorErrorCategory: "database",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readRuntime("conv-1")).toMatchObject({ agentSessionId: null });
	});

	it("defensively rejects a completed processor result that reports a mirror error", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
				runId: ctx.run.runId,
				workerId: "worker-1",
			});
			return {
				disposition: "completed",
				streamMetadata: {
					sessionId: "session-unreliable",
					mirrorErrorObserved: true,
					mirrorErrorCategory: "serialization",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readRuntime("conv-1")).toMatchObject({ agentSessionId: null });
	});
});

describe("RunLoop — shutdown", () => {
	it("interrupts in-flight runs on stop and terminalizes them as error", async () => {
		const worker = buildWorker(1);
		let sawAbort = false;
		// A processor that mirrors the SDK consumer: it runs until the run is
		// aborted, then throws — so shutdown never records a clean `done`.
		const loop = buildLoop(worker, async (ctx) => {
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve();
				ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			sawAbort = ctx.signal.aborted;
			throw new Error("interrupted by shutdown");
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch; processor blocks awaiting abort

		await loop.stop(); // aborts the active run, then drains

		expect(sawAbort).toBe(true);
		const row = await readRun("run-1");
		expect(row?.status).toBe("error");
		expect(await readEventTypes("run-1")).toEqual(["run_error"]);
	});
});

describe("RunLoop — stale-run recovery", () => {
	it("observes the degradation marker and duration created by stale recovery", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await expireOwnership("run-stale");
		const metrics: Record<string, unknown>[] = [];
		const telemetry: LiveStreamTelemetry = {
			record(operation, result, options) {
				metrics.push({ operation, result, ...options });
			},
		};
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			appendMessageProcessor,
			undefined,
			telemetry,
		);

		await loop.tick();

		expect(metrics).toEqual([
			{
				operation: "degradation",
				result: "started",
				reason: "stale_worker",
			},
			{
				operation: "degradation",
				result: "ended",
				reason: "stale_worker",
				durationMs: expect.any(Number),
			},
		]);
	});

	it("ends an existing degradation during stale recovery without duplicating its start", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await tdb.db
			.update(runs)
			.set({ liveStreamFailedAt: new Date(Date.now() - 1_000) })
			.where(eq(runs.runId, "run-stale"));
		await expireOwnership("run-stale");
		const metrics: Record<string, unknown>[] = [];
		const telemetry: LiveStreamTelemetry = {
			record(operation, result, options) {
				metrics.push({ operation, result, ...options });
			},
		};
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			appendMessageProcessor,
			undefined,
			telemetry,
		);

		await loop.tick();

		expect(metrics).toEqual([
			{
				operation: "degradation",
				result: "ended",
				reason: "stale_worker",
				durationMs: expect.any(Number),
			},
		]);
	});

	it("terminalizes stale running runs as error during a tick", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await expireOwnership("run-stale");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		const claimed = await loop.tick();
		await worker.drain();

		expect(claimed).toBe(0);
		expect((await readRun("run-stale"))?.status).toBe("error");
		expect(await readEventTypes("run-stale")).toEqual(["run_error"]);
	});

	it("terminalizes stale interrupt-requested runs as interrupted during a tick", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-stale",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await expireOwnership("run-stale");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-stale"))?.status).toBe("interrupted");
		expect(await readEventTypes("run-stale")).toEqual(["run_interrupted"]);
	});

	it("rejects stale worker appends after loop recovery terminalizes the run", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await expireOwnership("run-stale");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		await loop.tick();

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-stale",
				workerId: "stale-worker",
				type: "assistant_message_completed",
				payload: { messageId: "message-too-late", text: "too late" },
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
		expect(await readEventTypes("run-stale")).toEqual(["run_error"]);
	});

	it("does not double-terminalize when recovery beats an active processor", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		const loop = buildLoop(
			worker,
			async () => {
				await gate.promise;
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)
		await expireOwnership("run-1");

		await loop.tick(); // recovers stale run, then observes lost ownership
		gate.resolve();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readEventTypes("run-1")).toEqual(["run_error"]);
		expect(
			(await liveStreamRelay.attach("run-1", new AbortController().signal))
				.outcome,
		).toBe("no_producer");
		await liveStreamRelay.close();
	});
});

describe("RunLoop — model-content append", () => {
	it("maps each model-content kind to its durable event type", async () => {
		const worker = buildWorker(1);
		// One turn recording an Assistant message, a Tool invocation, and its result;
		// the loop, not the processor, owns the kind→type mapping.
		const loop = buildLoop(worker, async (ctx) => {
			await ctx.appendModelContent({
				kind: "assistant_message",
				payload: { messageId: "message-1", text: "listed" },
			});
			await ctx.appendModelContent({
				kind: "tool_call_started",
				payload: {
					toolCallId: "tool-1",
					toolCallName: "Bash",
					parentMessageId: "message-1",
				},
			});
			await ctx.appendModelContent({
				kind: "tool_call_args",
				payload: { toolCallId: "tool-1", delta: '{"command":"ls"}' },
			});
			await ctx.appendModelContent({
				kind: "tool_call_completed",
				payload: { toolCallId: "tool-1" },
			});
			await ctx.appendModelContent({
				kind: "tool_call_result",
				payload: {
					messageId: "tool-result-1",
					toolCallId: "tool-1",
					content: '{"exitCode":0}',
					isError: false,
				},
			});
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		const events = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"))
			.orderBy(runEvents.seq);
		expect(events.map((e) => e.type)).toEqual([
			"assistant_message_completed",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
			"run_done",
		]);
		expect(events[0]?.payload).toEqual({
			messageId: "message-1",
			text: "listed",
		});
		expect(events[1]?.payload).toEqual({
			toolCallId: "tool-1",
			toolCallName: "Bash",
			parentMessageId: "message-1",
		});
	});
});

describe("RunLoop — synthetic end-to-end smoke", () => {
	it("claims a queued run, commits an Assistant message, and ends it as done", async () => {
		const worker = buildWorker(2);
		const loop = buildLoop(worker, appendMessageProcessor);
		// A conversation queued a run (chat-api's admission side, mirrored here).
		await queueRun("run-smoke", "conv-smoke");

		const claimed = await loop.tick();
		await worker.drain();

		expect(claimed).toBe(1);
		const row = await readRun("run-smoke");
		expect(row?.status).toBe("done");
		expect(row?.lockedBy).toBeNull();
		// The durable event log carries the complete Assistant message ahead of the
		// terminal frame.
		expect(await readEventTypes("run-smoke")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});
});

/** Poll until `condition` holds; fail fast with a named timeout otherwise. */
async function waitUntil(
	condition: () => Promise<boolean> | boolean,
	label: string,
	timeoutMs = 4_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await Bun.sleep(5);
	}
}

/** A test doorbell: the test rings it and observes (un)subscription. */
function buildDoorbell() {
	let onRing: (() => void) | null = null;
	let unsubscribed = false;
	return {
		doorbell: {
			subscribe(callback: () => void): () => void {
				onRing = callback;
				return () => {
					unsubscribed = true;
					onRing = null;
				};
			},
		},
		ring: () => onRing?.(),
		get unsubscribed() {
			return unsubscribed;
		},
	};
}

describe("RunLoop — doorbell", () => {
	it("claims a queued run when the doorbell rings, without waiting for the timer", async () => {
		const worker = buildWorker(1);
		const bell = buildDoorbell();
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: appendMessageProcessor,
			// The timer cannot fire within the test window: only start()'s
			// immediate tick and the doorbell can claim.
			heartbeatIntervalMs: 3_600_000,
			logger: silentLogger,
			doorbell: bell.doorbell,
		});
		// The sentinel absorbs the immediate start() tick; with capacity 1 its
		// claim loop exits before another run could be claimed.
		await queueRun("run-sentinel", "conv-sentinel");
		loop.start();
		await waitUntil(
			async () => (await readRun("run-sentinel"))?.status === "done",
			"sentinel run to finish",
		);

		// Queued after every scheduled tick has completed: only a ring claims it.
		await queueRun("run-target", "conv-target");
		bell.ring();

		await waitUntil(
			async () => (await readRun("run-target"))?.status === "done",
			"doorbell ring to claim and finish the target run",
		);
		await loop.stop();
	});

	it("unsubscribes from the doorbell on stop, so a late ring claims nothing", async () => {
		const worker = buildWorker(1);
		const bell = buildDoorbell();
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: appendMessageProcessor,
			heartbeatIntervalMs: 3_600_000,
			logger: silentLogger,
			doorbell: bell.doorbell,
		});
		loop.start();
		await loop.stop();

		expect(bell.unsubscribed).toBe(true);
		await queueRun("run-late", "conv-late");
		bell.ring();
		await Bun.sleep(20);
		expect((await readRun("run-late"))?.status).toBe("queued");
	});
});
