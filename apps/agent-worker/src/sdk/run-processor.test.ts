import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type {
	SDKMessage,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import {
	createQueuedRunTx,
	requestRunInterruptionTx,
} from "@mymemo/agent-db/run-store";
import { createConversationRuntimeTx } from "@mymemo/agent-db/runtime-store";
import {
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { createInMemoryLiveStreamRelay } from "@mymemo/live-text";
import { eq } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import { RunLoop } from "../run-loop";
import { Worker } from "../worker";
import type { StartStopDeadline } from "./agent-stream";
import {
	createSdkRunProcessor,
	type RunQuery,
	type StartRunQuery,
} from "./run-processor";
import {
	createConversationSessionStore,
	type SessionMirrorEvidence,
} from "./session-store";
import {
	assistantBlock,
	streamEvent,
	textEnvelope,
} from "./testing/sdk-message-fixtures";
import {
	noSessionMirrorEvidence,
	withNoSessionMirrorEvidence,
} from "./testing/session-mirror-fixtures";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conv-1",
		scope: "general",
	});
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

function mirrorErrorMessage(): SDKMessage {
	return {
		type: "system",
		subtype: "mirror_error",
		error: "provider transcript detail",
		key: { projectKey: "p", sessionId: "s" },
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

function initMessage(sessionId: string): SDKMessage {
	return {
		type: "system",
		subtype: "init",
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

function messageQuery(
	messages: SDKMessage[],
	sessionEvidence: SessionMirrorEvidence = noSessionMirrorEvidence,
): RunQuery {
	return {
		close() {},
		async interrupt() {},
		sessionEvidence,
		async *[Symbol.asyncIterator]() {
			for (const message of messages) yield message;
		},
	};
}

function stepQuery(steps: Array<SDKMessage | { throw: unknown }>): RunQuery {
	return {
		close() {},
		async interrupt() {},
		sessionEvidence: noSessionMirrorEvidence,
		async *[Symbol.asyncIterator]() {
			for (const step of steps) {
				if ("throw" in step) throw step.throw;
				yield step;
			}
		},
	};
}

function buildLoop(
	worker: Worker,
	startRunQuery: StartRunQuery,
	logger: WorkerLogger = silentLogger,
	startStopDeadline?: StartStopDeadline,
) {
	return new RunLoop({
		db: tdb.db,
		worker,
		liveStreamRelay: createInMemoryLiveStreamRelay(),
		processor: createSdkRunProcessor({
			startRunQuery,
			logger,
			startStopDeadline,
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

function virtualStopDeadline(): {
	startStopDeadline: StartStopDeadline;
	elapse(): void;
	started: Promise<number>;
} {
	const elapsed = Promise.withResolvers<void>();
	const started = Promise.withResolvers<number>();
	return {
		startStopDeadline(timeoutMs) {
			started.resolve(timeoutMs);
			return {
				elapsed: elapsed.promise,
				cancel() {},
			};
		},
		elapse: () => elapsed.resolve(),
		started: started.promise,
	};
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
	it("does not publish a pointer from an SDK initialization id alone", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async (run) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
			});
			const store = createConversationSessionStore(tdb.db, {
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
				logger: silentLogger,
			});
			return messageQuery([initMessage("session-initialized")], store);
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
		expect(runtime?.agentSessionId).toBeNull();
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_done",
		]);
	});

	it("publishes the first pointer only when the bound store mirrored that main session", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async (run) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
			});
			const store = createConversationSessionStore(tdb.db, {
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
				logger: silentLogger,
			});
			await store.append(
				{ projectKey: "project-1", sessionId: "session-proven" },
				[{ type: "user", uuid: "main-entry" } as SessionStoreEntry],
			);
			return messageQuery([resultMessage("session-proven")], store);
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
		expect(runtime?.agentSessionId).toBe("session-proven");
	});

	it("does not publish a pointer from subagent-only mirroring", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async (run) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
			});
			const store = createConversationSessionStore(tdb.db, {
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
				logger: silentLogger,
			});
			await store.append(
				{
					projectKey: "project-1",
					sessionId: "session-subagent-only",
					subpath: "subagents/agent-1",
				},
				[{ type: "user", uuid: "subagent-entry" } as SessionStoreEntry],
			);
			return messageQuery([resultMessage("session-subagent-only")], store);
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
		expect(runtime?.agentSessionId).toBeNull();
	});

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
		expect(events.map((e) => e.type)).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
		expect(events[0]?.payload).toEqual({
			messageId: expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			),
			text: "Hello there.",
		});
	});

	it("keeps sequential envelopes separate, ignores non-text blocks, and skips empty messages", async () => {
		const worker = buildWorker();
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
		const loop = buildLoop(worker, async () => messageQuery(messages));
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
			"assistant_message_completed",
			"assistant_message_completed",
			"run_done",
		]);
		const commits = events.slice(0, 2).map((event) => event.payload) as Array<{
			messageId: string;
			text: string;
		}>;
		expect(commits.map(({ text }) => text)).toEqual(["ALPHA|BETA", "GAMMA"]);
		expect(new Set(commits.map(({ messageId }) => messageId)).size).toBe(2);
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
		// Both fixtures are otherwise-complete envelopes that would end the Run
		// `done` if their structurally impossible delta passed silently — the
		// nominally-successful malformed shape issue #244 requires to fail closed.
		{
			name: "a thinking delta inside a tool_use block",
			messages: [
				streamEvent({
					type: "message_start",
					message: { id: "provider-1", content: [] },
				}),
				streamEvent({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu-0",
						name: "WebSearch",
						input: {},
					},
				}),
				streamEvent({
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "…" },
				}),
				assistantBlock("provider-1", {
					type: "tool_use",
					id: "toolu-0",
					name: "WebSearch",
					input: {},
				}),
				streamEvent({ type: "content_block_stop", index: 0 }),
				streamEvent({ type: "message_stop" }),
			],
		},
		{
			name: "an input_json delta inside a thinking block",
			messages: [
				streamEvent({
					type: "message_start",
					message: { id: "provider-1", content: [] },
				}),
				streamEvent({
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "", signature: "" },
				}),
				streamEvent({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: "{}" },
				}),
				assistantBlock("provider-1", {
					type: "thinking",
					thinking: "",
					signature: "",
				}),
				streamEvent({ type: "content_block_stop", index: 0 }),
				streamEvent({ type: "message_stop" }),
			],
		},
	]) {
		it(`fails the Run closed for ${fixture.name}`, async () => {
			const worker = buildWorker();
			const loop = buildLoop(worker, async () =>
				messageQuery(fixture.messages),
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
			expect(events[0]?.payload).toEqual({
				message: "Run failed",
				outcome: "error",
			});
		});
	}

	it("fails a Run whose streamed text disagrees with provider completion", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async () =>
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

	it("fails fast on mirror_error without establishing a first session pointer", async () => {
		const worker = buildWorker();
		const settled = Promise.withResolvers<void>();
		const calls: string[] = [];
		const errors: Record<string, unknown>[] = [];
		let toolAbortReason: unknown;
		let artifactPublicationReads = 0;
		let deadlineMs: number | undefined;
		let deadlineCancelled = false;
		const logger: WorkerLogger = {
			info() {},
			warn() {},
			error(fields) {
				errors.push(fields);
			},
		};
		const loop = buildLoop(
			worker,
			async (run, signal) => {
				await createConversationRuntimeTx(tdb.db, {
					userId: run.userId,
					conversationId: run.conversationId,
					runId: run.runId,
					workerId: "worker-1",
				});
				signal.addEventListener(
					"abort",
					() => {
						calls.push("tool-abort");
						toolAbortReason = signal.reason;
					},
					{ once: true },
				);
				return withNoSessionMirrorEvidence({
					async interrupt() {
						calls.push("interrupt");
						settled.resolve();
					},
					close() {
						calls.push("close");
						settled.resolve();
					},
					async *[Symbol.asyncIterator]() {
						yield resultMessage("session-unreliable");
						yield mirrorErrorMessage();
						await settled.promise;
					},
					getArtifactPublication() {
						artifactPublicationReads++;
						return { artifacts: [] };
					},
				});
			},
			logger,
			(timeoutMs) => {
				deadlineMs = timeoutMs;
				return {
					elapsed: new Promise(() => {}),
					cancel() {
						deadlineCancelled = true;
					},
				};
			},
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect(toolAbortReason).toEqual(new Error("agent session mirror failed"));
		expect(artifactPublicationReads).toBe(0);
		expect(deadlineMs).toBe(30_000);
		expect(deadlineCancelled).toBe(true);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
		expect((await readEvents("run-1"))[0]?.payload).toEqual({
			message: "Run failed",
			outcome: "error",
		});
		expect(errors).toContainEqual({
			message: "agent session mirror failed",
			workerId: "worker-1",
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
			reason: "mirror_error",
		});
		expect(JSON.stringify(errors)).not.toContain("provider transcript detail");
		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect(runtime?.agentSessionId).toBeNull();
	});

	it("lets an already-committed interruption win over mirror_error", async () => {
		const worker = buildWorker();
		const started = Promise.withResolvers<void>();
		const releaseMirrorError = Promise.withResolvers<void>();
		const calls: string[] = [];
		const loop = buildLoop(worker, async (_run, signal) => {
			signal.addEventListener("abort", () => calls.push("tool-abort"), {
				once: true,
			});
			return withNoSessionMirrorEvidence({
				async interrupt() {
					calls.push("interrupt");
				},
				close() {
					calls.push("close");
				},
				async *[Symbol.asyncIterator]() {
					started.resolve();
					await releaseMirrorError.promise;
					yield mirrorErrorMessage();
				},
			});
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await loop.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		releaseMirrorError.resolve();
		await worker.drain();

		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_interrupted",
		]);
	});

	it("retains an existing session pointer after mirror_error", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async (run) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
			});
			await tdb.db
				.update(conversationRuntime)
				.set({ agentSessionId: "session-existing" })
				.where(eq(conversationRuntime.conversationId, run.conversationId));
			return messageQuery([
				resultMessage("session-unreliable"),
				mirrorErrorMessage(),
			]);
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect(runtime?.agentSessionId).toBe("session-existing");
	});

	it("stops an interrupted Run cleanly inside the 30-second deadline", async () => {
		const worker = buildWorker();
		const started = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const calls: string[] = [];
		let deadlineMs: number | undefined;
		let deadlineCancelled = false;
		const loop = buildLoop(
			worker,
			async (_run, signal) => {
				signal.addEventListener("abort", () => calls.push("tool-abort"), {
					once: true,
				});
				started.resolve();
				return withNoSessionMirrorEvidence({
					async interrupt() {
						calls.push("interrupt");
						settled.resolve();
					},
					close() {
						calls.push("close");
						settled.resolve();
					},
					// biome-ignore lint/correctness/useYield: models a silent SDK query that settles after interrupt.
					async *[Symbol.asyncIterator]() {
						await settled.promise;
					},
				});
			},
			silentLogger,
			(timeoutMs) => {
				deadlineMs = timeoutMs;
				return {
					elapsed: new Promise<void>(() => {}),
					cancel() {
						deadlineCancelled = true;
					},
				};
			},
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await loop.tick();
		await worker.drain();

		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect(deadlineMs).toBe(30_000);
		expect(deadlineCancelled).toBe(true);
		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_interrupted",
		]);
	});

	it("keeps heartbeating a hung interrupted Run and force-closes it after the deadline", async () => {
		const worker = buildWorker();
		const started = Promise.withResolvers<void>();
		const interrupted = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const calls: string[] = [];
		const warnings: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			info() {},
			error() {},
			warn(fields) {
				warnings.push(fields);
			},
		};
		const deadline = virtualStopDeadline();
		const loop = buildLoop(
			worker,
			async (run, signal) => {
				await createConversationRuntimeTx(tdb.db, {
					userId: run.userId,
					conversationId: run.conversationId,
					runId: run.runId,
					workerId: "worker-1",
				});
				const store = createConversationSessionStore(tdb.db, {
					conversationId: run.conversationId,
					runId: run.runId,
					workerId: "worker-1",
					logger: silentLogger,
				});
				await store.append(
					{ projectKey: "project-1", sessionId: "session-interrupted" },
					[{ type: "user", uuid: "main-entry" } as SessionStoreEntry],
				);
				signal.addEventListener("abort", () => calls.push("tool-abort"), {
					once: true,
				});
				started.resolve();
				return Object.assign(
					{
						async interrupt() {
							calls.push("interrupt");
							interrupted.resolve();
						},
						close() {
							calls.push("close");
							closed.resolve();
						},
						// biome-ignore lint/correctness/useYield: models a hung SDK query released only by close.
						async *[Symbol.asyncIterator]() {
							await closed.promise;
						},
					},
					{ sessionEvidence: store },
				);
			},
			logger,
			deadline.startStopDeadline,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await loop.tick();
		await interrupted.promise;
		expect(await deadline.started).toBe(30_000);
		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect((await readRun("run-1"))?.status).toBe("interrupt_requested");

		await tdb.db
			.update(runs)
			.set({ lockedUntil: new Date(Date.now() + 1_000) })
			.where(eq(runs.runId, "run-1"));
		await loop.tick();
		expect((await readRun("run-1"))?.lockedUntil?.getTime()).toBeGreaterThan(
			Date.now() + 30_000,
		);
		expect(calls).toEqual(["tool-abort", "interrupt"]);

		deadline.elapse();
		await worker.drain();

		expect(calls).toEqual(["tool-abort", "interrupt", "close"]);
		expect(warnings).toContainEqual({
			message: "agent query exceeded stop deadline; forcing close",
			runId: "run-1",
			stopDeadlineMs: 30_000,
		});
		expect((await readRun("run-1"))?.status).toBe("interrupted");
		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect(runtime?.agentSessionId).toBe("session-interrupted");
	});

	it("force-closes immediately and writes no terminal Outcome after ownership loss", async () => {
		const worker = buildWorker();
		const started = Promise.withResolvers<void>();
		const releaseStream = Promise.withResolvers<void>();
		const deadline = virtualStopDeadline();
		const calls: string[] = [];
		const loop = buildLoop(
			worker,
			async () => {
				started.resolve();
				return withNoSessionMirrorEvidence({
					async interrupt() {
						calls.push("interrupt");
					},
					close() {
						calls.push("close");
					},
					// biome-ignore lint/correctness/useYield: close is intentionally controllable in this fence race.
					async *[Symbol.asyncIterator]() {
						await releaseStream.promise;
					},
				});
			},
			silentLogger,
			deadline.startStopDeadline,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await loop.tick();
		await started.promise;
		await tdb.db
			.update(runs)
			.set({
				lockedBy: "worker-2",
				lockedUntil: new Date(Date.now() + 60_000),
			})
			.where(eq(runs.runId, "run-1"));
		await loop.tick();
		await Promise.resolve();

		expect(calls).toEqual(["close"]);
		releaseStream.resolve();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "running",
			lockedBy: "worker-2",
		});
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("writes no terminal Outcome when the fence is lost after forced close", async () => {
		const worker = buildWorker();
		const started = Promise.withResolvers<void>();
		const closeCalled = Promise.withResolvers<void>();
		const releaseStream = Promise.withResolvers<void>();
		const deadline = virtualStopDeadline();
		const loop = buildLoop(
			worker,
			async () =>
				withNoSessionMirrorEvidence({
					async interrupt() {},
					close() {
						closeCalled.resolve();
					},
					// biome-ignore lint/correctness/useYield: stream settlement is held past forced close to revoke the fence.
					async *[Symbol.asyncIterator]() {
						started.resolve();
						await releaseStream.promise;
					},
				}),
			silentLogger,
			deadline.startStopDeadline,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await loop.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await loop.tick();
		deadline.elapse();
		await closeCalled.promise;

		await tdb.db
			.update(runs)
			.set({
				lockedBy: "worker-2",
				lockedUntil: new Date(Date.now() + 60_000),
			})
			.where(eq(runs.runId, "run-1"));
		releaseStream.resolve();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "interrupt_requested",
			lockedBy: "worker-2",
		});
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("force-closes a query-local infrastructure stop and maps it to error", async () => {
		const worker = buildWorker();
		const started = Promise.withResolvers<void>();
		const forceCloseController = new AbortController();
		const calls: string[] = [];
		const loop = buildLoop(
			worker,
			async () =>
				withNoSessionMirrorEvidence({
					forceCloseSignal: forceCloseController.signal,
					async interrupt() {
						calls.push("interrupt");
					},
					close() {
						calls.push("close");
					},
					async *[Symbol.asyncIterator]() {
						started.resolve();
						if (!forceCloseController.signal.aborted) {
							await new Promise<void>((resolve) =>
								forceCloseController.signal.addEventListener(
									"abort",
									() => resolve(),
									{ once: true },
								),
							);
						}
					},
				}),
			silentLogger,
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await started.promise;
		forceCloseController.abort();
		await worker.drain();

		expect(calls).toEqual(["close"]);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
	});

	it("maps worker shutdown of a supervised query to error", async () => {
		const worker = buildWorker();
		const started = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const calls: string[] = [];
		let deadlines = 0;
		const loop = buildLoop(
			worker,
			async (_run, _signal) =>
				withNoSessionMirrorEvidence({
					async interrupt() {
						calls.push("interrupt");
						settled.resolve();
					},
					close() {
						calls.push("close");
						settled.resolve();
					},
					// biome-ignore lint/correctness/useYield: models a query stopped by worker shutdown.
					async *[Symbol.asyncIterator]() {
						started.resolve();
						await settled.promise;
					},
				}),
			silentLogger,
			() => {
				deadlines++;
				return { elapsed: new Promise(() => {}), cancel() {} };
			},
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await loop.tick();
		await started.promise;

		await loop.stop();

		expect(calls).toEqual(["close"]);
		expect(deadlines).toBe(0);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
	});

	for (const lateResult of ["success", "error"] as const) {
		it(`lets durable interruption beat a late SDK ${lateResult}`, async () => {
			const worker = buildWorker();
			const started = Promise.withResolvers<void>();
			const stopped = Promise.withResolvers<void>();
			const deadline = virtualStopDeadline();
			const loop = buildLoop(
				worker,
				async () =>
					withNoSessionMirrorEvidence({
						async interrupt() {
							stopped.resolve();
						},
						close() {
							stopped.resolve();
						},
						async *[Symbol.asyncIterator]() {
							started.resolve();
							await stopped.promise;
							if (lateResult === "error") throw new Error("late SDK error");
							yield resultMessage("late-session");
						},
					}),
				silentLogger,
				deadline.startStopDeadline,
			);
			await createQueuedRunTx(tdb.db, {
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
			});
			await loop.tick();
			await started.promise;
			await requestRunInterruptionTx(tdb.db, {
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
			});

			await loop.tick();
			await worker.drain();

			expect((await readRun("run-1"))?.status).toBe("interrupted");
			expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
				"run_interrupted",
			]);
		});
	}

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

	it("advances the agent-session pointer only after a valid successful stream", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async (run) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: "worker-1",
			});
			return messageQuery(
				[
					...textEnvelope({ completeText: "answer" }),
					resultMessage("session-valid"),
				],
				{
					mirroredMainSessionId() {
						return "session-valid";
					},
				},
			);
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
			"assistant_message_completed",
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
