import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createQueuedRunTx } from "@mymemo/agent-db/run-store";
import { createConversationRuntimeTx } from "@mymemo/agent-db/runtime-store";
import { conversationRuntime, runEvents, runs } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import {
	InMemoryLiveTextTransport,
	type LiveTextPublisher,
} from "@mymemo/live-text";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import { RunLoop } from "../run-loop";
import { Worker } from "../worker";
import type { SupervisedQuery } from "./agent-stream";
import { createSdkRunProcessor, type StartRunQuery } from "./run-processor";
import {
	assistantBlock,
	streamEvent,
	textEnvelope,
} from "./testing/sdk-message-fixtures";

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
});

interface EnvelopeBlock {
	type: "text" | "tool_use" | "other";
	completeText?: string;
	partialText?: string;
}

function providerEnvelope(
	providerMessageId: string,
	blocks: EnvelopeBlock[],
): SDKMessage[] {
	const messages: SDKMessage[] = [
		streamEvent({
			type: "message_start",
			message: { id: providerMessageId, content: [] },
		}),
	];
	for (const [index, block] of blocks.entries()) {
		// A tool_use block carries the real SDK shape but a non-allowlisted name,
		// so it is omitted from the client stream rather than committed (ADR-0009).
		const blockShape =
			block.type === "text"
				? { type: "text", text: "" }
				: block.type === "tool_use"
					? {
							type: "tool_use",
							id: `toolu-${index}`,
							name: "WebSearch",
							input: {},
						}
					: { type: block.type };
		messages.push(
			streamEvent({
				type: "content_block_start",
				index,
				content_block: blockShape,
			}),
		);
		if (block.type === "text") {
			messages.push(
				streamEvent({
					type: "content_block_delta",
					index,
					delta: {
						type: "text_delta",
						text: block.partialText ?? block.completeText ?? "",
					},
				}),
				assistantBlock(providerMessageId, {
					type: "text",
					text: block.completeText ?? "",
				}),
			);
		} else {
			messages.push(
				streamEvent({
					type: "content_block_delta",
					index,
					delta: { type: "input_json_delta", partial_json: "{}" },
				}),
				assistantBlock(providerMessageId, blockShape),
			);
		}
		messages.push(streamEvent({ type: "content_block_stop", index }));
	}
	messages.push(streamEvent({ type: "message_stop" }));
	return messages;
}

function resultMessage(sessionId = "session-1"): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "terminal result echo",
		session_id: sessionId,
	} as unknown as SDKMessage;
}

function errorResultMessage(text: string): SDKMessage {
	return {
		type: "result",
		subtype: "error_during_execution",
		is_error: true,
		errors: [text],
	} as unknown as SDKMessage;
}

function messageQuery(messages: SDKMessage[]): SupervisedQuery {
	return {
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			for (const message of messages) yield message;
		},
	};
}

function stepQuery(
	steps: Array<SDKMessage | { throw: unknown }>,
): SupervisedQuery {
	return {
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			for (const step of steps) {
				if ("throw" in step) throw step.throw;
				yield step;
			}
		},
	};
}

/**
 * A query that yields one message then blocks until the run is aborted, then
 * emits one more (ignored) message and ends — as a real interrupt would. Records
 * interrupt calls so the test can assert the supervisor interrupted the query.
 */
function cancelableQuery(
	signal: AbortSignal,
	firstText: string,
): SupervisedQuery & { interrupts: number } {
	const q = {
		interrupts: 0,
		async interrupt() {
			q.interrupts++;
		},
		async *[Symbol.asyncIterator]() {
			const envelope = textEnvelope({ completeText: firstText });
			for (const message of envelope.slice(0, 4)) yield message;
			await new Promise<void>((resolve) => {
				if (signal.aborted) return resolve();
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			for (const message of envelope.slice(4)) yield message;
		},
	};
	return q;
}

function buildLoop(
	worker: Worker,
	startRunQuery: StartRunQuery,
	logger: WorkerLogger = silentLogger,
	liveTextPublisher?: LiveTextPublisher,
) {
	return new RunLoop({
		db: tdb.db,
		worker,
		processor: createSdkRunProcessor({
			startRunQuery,
			logger,
			liveTextPublisher,
		}),
		heartbeatIntervalMs: 15_000,
		logger,
	});
}

function buildWorker() {
	return new Worker({
		workerId: "worker-1",
		maxConcurrentRuns: 1,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
}

function stalledPublisher() {
	let resolveStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let aborted = false;
	const publisher: LiveTextPublisher = {
		async publish(_message, options) {
			resolveStarted();
			await new Promise<void>((resolve) => {
				options?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve();
					},
					{ once: true },
				);
			});
		},
	};
	return { publisher, started, wasAborted: () => aborted };
}

async function readRun(runId: string) {
	const [row] = await tdb.db.select().from(runs).where(eq(runs.runId, runId));
	return row;
}

async function readEvents(runId: string) {
	const rows = await tdb.db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(runEvents.seq);
	return rows;
}

describe("createSdkRunProcessor — through the run loop", () => {
	it("commits one durable Assistant message for a complete provider envelope", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async () =>
			messageQuery(textEnvelope({ completeText: "Hello there." })),
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["assistant_text", "run_done"]);
		expect(events[0]?.payload).toEqual({
			messageId: expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			),
			text: "Hello there.",
		});
	});

	it("keeps sequential envelopes separate, ignores non-text blocks, and skips empty messages", async () => {
		const worker = buildWorker();
		const transport = new InMemoryLiveTextTransport();
		const subscription = await transport.subscribe("run-1");
		const messages = [
			...providerEnvelope("provider-1", [
				{ type: "text", completeText: "ALPHA|" },
				{ type: "tool_use" },
				{ type: "text", completeText: "BETA" },
			]),
			...providerEnvelope("provider-2", [{ type: "tool_use" }]),
			...providerEnvelope("provider-3", [
				{ type: "other" },
				{ type: "text", completeText: "GAMMA" },
			]),
			resultMessage(),
		];
		const loop = buildLoop(
			worker,
			async () => messageQuery(messages),
			silentLogger,
			transport,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		const events = await readEvents("run-1");
		expect(events.map((event) => event.type)).toEqual([
			"assistant_text",
			"assistant_text",
			"run_done",
		]);
		const commits = events.slice(0, 2).map((event) => event.payload) as Array<{
			messageId: string;
			text: string;
		}>;
		expect(commits.map(({ text }) => text)).toEqual(["ALPHA|BETA", "GAMMA"]);
		expect(new Set(commits.map(({ messageId }) => messageId)).size).toBe(2);
		expect(subscription.readAvailable()).toEqual(
			commits.map(({ messageId, text }) => ({
				runId: "run-1",
				messageId,
				deltaIndex: 0,
				text,
			})),
		);
	});

	for (const fixture of [
		{
			name: "a missing message_stop",
			messages: providerEnvelope("provider-1", [
				{ type: "text" as const, completeText: "UNCOMMITTED" },
			]).slice(0, -1),
		},
		{
			name: "message_stop without message_start",
			messages: [streamEvent({ type: "message_stop" })],
		},
		{
			name: "overlapping message envelopes",
			messages: [
				streamEvent({
					type: "message_start",
					message: { id: "provider-1", content: [] },
				}),
				streamEvent({
					type: "message_start",
					message: { id: "provider-2", content: [] },
				}),
			],
		},
		{
			name: "overlapping content blocks",
			messages: [
				streamEvent({
					type: "message_start",
					message: { id: "provider-1", content: [] },
				}),
				streamEvent({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
				streamEvent({
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use" },
				}),
			],
		},
		{
			name: "completed content from a different provider envelope",
			messages: [
				...textEnvelope({ completeText: "wrong envelope" }).slice(0, 3),
				assistantBlock("provider-message-2", {
					type: "text",
					text: "wrong envelope",
				}),
			],
		},
		{
			name: "a malformed completed text block",
			messages: [
				...textEnvelope({ completeText: "valid partial" }).slice(0, 3),
				{
					type: "assistant",
					message: {
						id: "provider-message-1",
						content: [{ type: "text", text: 42 }],
					},
					parent_tool_use_id: null,
					uuid: crypto.randomUUID(),
					session_id: "s",
				} as unknown as SDKMessage,
				...textEnvelope({ completeText: "valid partial" }).slice(4),
			],
		},
		{
			name: "a content delta after block completion",
			messages: [
				...textEnvelope({ completeText: "complete" }).slice(0, 4),
				streamEvent({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "late" },
				}),
				...textEnvelope({ completeText: "complete" }).slice(4),
			],
		},
		{
			name: "message_delta while a content block is active",
			messages: [
				...textEnvelope({ completeText: "complete" }).slice(0, 2),
				streamEvent({
					type: "message_delta",
					delta: { stop_reason: null, stop_sequence: null },
					usage: { output_tokens: 1 },
				}),
				...textEnvelope({ completeText: "complete" }).slice(2),
			],
		},
		{
			name: "a content block after message_delta",
			messages: [
				...providerEnvelope("provider-message-1", [
					{ type: "text", completeText: "ALPHA" },
					{ type: "text", completeText: "BETA" },
				]).slice(0, 5),
				streamEvent({
					type: "message_delta",
					delta: { stop_reason: null, stop_sequence: null },
					usage: { output_tokens: 1 },
				}),
				...providerEnvelope("provider-message-1", [
					{ type: "text", completeText: "ALPHA" },
					{ type: "text", completeText: "BETA" },
				]).slice(5),
			],
		},
		{
			name: "duplicate message_delta events",
			messages: [
				...textEnvelope({ completeText: "complete" }).slice(0, -1),
				streamEvent({
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				}),
				streamEvent({
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				}),
				streamEvent({ type: "message_stop" }),
			],
		},
	]) {
		it(`fails the Run closed for ${fixture.name}`, async () => {
			const warnings: Record<string, unknown>[] = [];
			const logger: WorkerLogger = {
				...silentLogger,
				warn: (event) => warnings.push(event),
			};
			const worker = buildWorker();
			const loop = buildLoop(
				worker,
				async () => messageQuery(fixture.messages),
				logger,
			);
			await createQueuedRunTx(tdb.db, {
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
			});

			await loop.tick();
			await worker.drain();

			expect((await readRun("run-1"))?.status).toBe("error");
			const events = await readEvents("run-1");
			expect(events.map((event) => event.type)).toEqual(["run_error"]);
			expect(events[0]?.payload).toEqual({ message: "Run failed" });
			expect(warnings).toContainEqual({
				message: "Live preview signal",
				service: "agent-worker",
				signal: "impossible_ordering",
				reason: "provider_envelope",
				count: 1,
			});
			expect(JSON.stringify(warnings)).not.toContain("complete");
		});
	}

	it("commits completed text on mismatch without forcing pending preview", async () => {
		const warnings: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			...silentLogger,
			warn(event) {
				warnings.push(event);
				throw new Error("telemetry unavailable");
			},
		};
		const worker = buildWorker();
		const transport = new InMemoryLiveTextTransport();
		const subscription = await transport.subscribe("run-1");
		const loop = buildLoop(
			worker,
			async () =>
				messageQuery([
					...textEnvelope({
						completeText: "COMMIT",
						providerMessageId: "provider-1",
						partialText: "PREVIEW",
					}),
					...textEnvelope({
						completeText: "NEXT",
						providerMessageId: "provider-2",
					}),
				]),
			logger,
			transport,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		const events = await readEvents("run-1");
		expect(
			events
				.filter((event) => event.type === "assistant_text")
				.map((event) => (event.payload as { text: string }).text),
		).toEqual(["COMMIT", "NEXT"]);
		expect(warnings).toEqual([
			{
				message: "Live preview signal",
				service: "agent-worker",
				signal: "dropped",
				reason: "partial_complete",
				outcome: "dropped",
				count: 1,
			},
			{
				message: "Live preview signal",
				service: "agent-worker",
				signal: "mismatch",
				reason: "partial_complete",
				count: 1,
			},
		]);
		expect(JSON.stringify(warnings)).not.toContain("PREVIEW");
		expect(JSON.stringify(warnings)).not.toContain("COMMIT");
		expect(subscription.readAvailable()).toEqual([]);
	});

	it("keeps the Run done and emits a payload-free signal when publication fails", async () => {
		const warnings: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			...silentLogger,
			warn(event) {
				warnings.push(event);
			},
		};
		const worker = buildWorker();
		const loop = buildLoop(
			worker,
			async () =>
				messageQuery(textEnvelope({ completeText: "authoritative answer" })),
			logger,
			{
				async publish() {
					throw new Error("transport unavailable");
				},
			},
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(
			(await readEvents("run-1"))
				.filter((event) => event.type === "assistant_text")
				.map((event) => (event.payload as { text: string }).text),
		).toEqual(["authoritative answer"]);
		expect(warnings).toEqual([
			{
				message: "Live preview signal",
				service: "agent-worker",
				signal: "dropped",
				reason: "publisher",
				outcome: "dropped",
				count: 1,
			},
		]);
		expect(JSON.stringify(warnings)).not.toContain("authoritative answer");
	});

	it("passes the claimed run and abort signal to startRunQuery", async () => {
		const worker = buildWorker();
		let seenRunId: string | undefined;
		let sawSignal = false;
		const loop = buildLoop(worker, async (run, signal) => {
			seenRunId = run.runId;
			sawSignal = signal instanceof AbortSignal;
			return messageQuery(textEnvelope({ completeText: "ok" }));
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect(seenRunId).toBe("run-1");
		expect(sawSignal).toBe(true);
	});

	it("terminalizes an SDK failure with the generic client message", async () => {
		const worker = buildWorker();
		const incomplete = textEnvelope({ completeText: "partial" }).slice(0, 4);
		const loop = buildLoop(worker, async () =>
			stepQuery([...incomplete, { throw: new Error("model exploded") }]),
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		const run = await readRun("run-1");
		expect(run?.status).toBe("error");
		const events = await readEvents("run-1");
		expect(events.map((event) => event.type)).toEqual(["run_error"]);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("run_error");
		expect((terminal?.payload as { message: string }).message).toBe(
			"Run failed",
		);
		expect(JSON.stringify(terminal?.payload)).not.toContain("model exploded");
	});

	it("records one error outcome for an SDK error result followed by rejection", async () => {
		const worker = buildWorker();
		const incomplete = textEnvelope({ completeText: "partial" }).slice(0, 4);
		const loop = buildLoop(worker, async () =>
			stepQuery([
				...incomplete,
				errorResultMessage("provider rejected the request"),
				{ throw: new Error("iterator rejected after error result") },
			]),
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		const events = await readEvents("run-1");
		expect(events.map((event) => event.type)).toEqual(["run_error"]);
		expect(JSON.stringify(events[0]?.payload)).not.toContain("provider");
	});

	it("abandons an open message after cancel_requested and terminalizes as canceled", async () => {
		const worker = buildWorker();
		let query: (SupervisedQuery & { interrupts: number }) | undefined;
		const live = stalledPublisher();
		const loop = buildLoop(
			worker,
			async (_run, signal) => {
				query = cancelableQuery(signal, "x".repeat(16_384));
				return query;
			},
			silentLogger,
			live.publisher,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick(); // claim + dispatch; processor streams "before cancel"
		await live.started;

		// User cancels the running run.
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested", cancelRequestedAt: sql`now()` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeat observes cancel → aborts the run's signal
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("canceled");
		const types = (await readEvents("run-1")).map((e) => e.type);
		expect(types).toEqual(["run_canceled"]);
		expect(query?.interrupts).toBeGreaterThanOrEqual(1);
		expect(live.wasAborted()).toBe(true);
	});

	it("discards pending preview after ownership loss without terminalizing", async () => {
		const worker = buildWorker();
		const live = stalledPublisher();
		const loop = buildLoop(
			worker,
			async (_run, signal) => cancelableQuery(signal, "x".repeat(16_384)),
			silentLogger,
			live.publisher,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await live.started;
		await tdb.db
			.update(runs)
			.set({
				lockedBy: "worker-2",
				lockedUntil: sql`now() + interval '60 seconds'`,
			})
			.where(eq(runs.runId, "run-1"));
		await loop.tick();
		await worker.drain();

		expect(live.wasAborted()).toBe(true);
		expect((await readRun("run-1"))?.lockedBy).toBe("worker-2");
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("discards pending preview when shutdown aborts the active Run", async () => {
		const worker = buildWorker();
		const live = stalledPublisher();
		const loop = buildLoop(
			worker,
			async (_run, signal) => cancelableQuery(signal, "x".repeat(16_384)),
			silentLogger,
			live.publisher,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await live.started;
		await loop.stop();

		expect(live.wasAborted()).toBe(true);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
	});

	it("advances the agent-session pointer only after a valid successful stream", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async (run) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
			});
			return messageQuery([
				...textEnvelope({ completeText: "answer" }),
				resultMessage("session-valid"),
			]);
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("done");
		expect(runtime?.agentSessionId).toBe("session-valid");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"assistant_text",
			"run_done",
		]);
	});

	it("does not advance the agent-session pointer for an invalid envelope", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async (run) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
			});
			return messageQuery([
				...textEnvelope({ completeText: "uncommitted" }).slice(0, -1),
				resultMessage("session-invalid"),
			]);
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect(runtime?.agentSessionId).toBeNull();
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
	});
});
