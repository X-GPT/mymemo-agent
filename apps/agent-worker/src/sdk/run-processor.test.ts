import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import type {
	SDKMessage,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import {
	type RunWriteOwner,
	requestRunInterruptionTx,
} from "@mymemo/agent-db/run-store";
import { createConversationRuntimeTx } from "@mymemo/agent-db/runtime-store";
import {
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import {
	createTestDatabase,
	lapseConversationOwnership,
	seedQueuedRun,
	type TestDb,
} from "@mymemo/agent-db/testing";
import {
	createInMemoryLiveStreamRelay,
	decodeAgUiLiveStreamEvent,
	type LiveStreamEvent,
	type LiveStreamRelay,
} from "@mymemo/live-text";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import { createAgentCoreRunHarness } from "../testing/agentcore-run-harness";
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
	toolEnvelope,
	toolResultUserMessage,
} from "./testing/sdk-message-fixtures";
import {
	noSessionMirrorEvidence,
	withNoSessionMirrorEvidence,
	withSessionMirrorEvidence,
} from "./testing/session-mirror-fixtures";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };
const noArtifactPublication = { getArtifactPublication: () => null };

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conv-1",
		scope: "general",
		executionRuntime: "agentcore",
	});
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversationRuntime);
	await tdb.db
		.update(conversations)
		.set({ ownerWorkerId: null, ownerUntil: null });
});

interface EnvelopeBlock {
	type: "text" | "tool_use" | "other";
	completeText?: string;
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
						text: block.completeText ?? "",
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
		getArtifactPublication: () => null,
		sessionEvidence,
		async *[Symbol.asyncIterator]() {
			for (const message of messages) yield message;
		},
	};
}

function stepQuery(
	steps: Array<SDKMessage | { throw: unknown }>,
	sessionEvidence: SessionMirrorEvidence = noSessionMirrorEvidence,
): RunQuery {
	return {
		close() {},
		async interrupt() {},
		getArtifactPublication: () => null,
		sessionEvidence,
		async *[Symbol.asyncIterator]() {
			for (const step of steps) {
				if ("throw" in step) throw step.throw;
				yield step;
			}
		},
	};
}

function buildHarness(
	startRunQuery: StartRunQuery,
	logger: WorkerLogger = silentLogger,
	startStopDeadline?: StartStopDeadline,
	liveStreamRelay: LiveStreamRelay = createInMemoryLiveStreamRelay(),
) {
	return createAgentCoreRunHarness({
		db: tdb.db,
		liveStreamRelay,
		processor: createSdkRunProcessor({
			startRunQuery,
			logger,
			startStopDeadline,
		}),
		logger,
	});
}

async function createRuntimeFor(owner: RunWriteOwner): Promise<void> {
	await createConversationRuntimeTx(tdb.db, owner);
}

async function createRuntimeSessionStoreFor(owner: RunWriteOwner) {
	await createRuntimeFor(owner);
	return createConversationSessionStore(tdb.db, {
		owner,
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

async function collectAttachedEvents(
	relay: LiveStreamRelay,
	runId: string,
): Promise<LiveStreamEvent[]> {
	const attached = await relay.attach(runId, new AbortController().signal);
	if (attached.outcome !== "attached") {
		throw new Error(`expected ${runId} Live Stream attachment`);
	}
	const events: LiveStreamEvent[] = [];
	for await (const chunk of attached.events) {
		events.push(decodeAgUiLiveStreamEvent(chunk));
	}
	return events;
}

describe("createSdkRunProcessor — through the run harness", () => {
	it("carries scripted PresentUI through the durable fence and Live Stream reconnect", async () => {
		const relay = createInMemoryLiveStreamRelay();
		const processorStarted = Promise.withResolvers<void>();
		const startQuery = Promise.withResolvers<void>();
		const envelopeConsumed = Promise.withResolvers<void>();
		const finishQuery = Promise.withResolvers<void>();
		const uiInput = {
			component: "diagram",
			props: { source: "flowchart LR\nA --> B" },
		};
		const messages = [
			...toolEnvelope({
				text: "Here is the process.",
				toolUses: [
					{
						toolUseId: "toolu-ui-1",
						name: "mcp__mymemo-executor__PresentUI",
						input: uiInput,
					},
				],
			}),
			toolResultUserMessage([
				{ toolUseId: "toolu-ui-1", text: '{"accepted":true}' },
			]),
		];
		const harness = buildHarness(
			async () => {
				processorStarted.resolve();
				await startQuery.promise;
				return {
					close() {},
					async interrupt() {},
					getArtifactPublication: () => null,
					sessionEvidence: noSessionMirrorEvidence,
					async *[Symbol.asyncIterator]() {
						for (const message of messages) yield message;
						envelopeConsumed.resolve();
						await finishQuery.promise;
						yield resultMessage();
					},
				};
			},
			silentLogger,
			undefined,
			relay,
		);
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await processorStarted.promise;
		const originalEvents = collectAttachedEvents(relay, "run-1");
		startQuery.resolve();
		await envelopeConsumed.promise;
		const reconnectEvents = collectAttachedEvents(relay, "run-1");
		finishQuery.resolve();
		await harness.drain();
		const [original, reconnect] = await Promise.all([
			originalEvents,
			reconnectEvents,
		]);

		const durable = await readEvents("run-1");
		expect(durable.map(({ type }) => type)).toEqual([
			"assistant_message_completed",
			"ui_payload",
			"run_done",
		]);
		const assistant = durable[0]?.payload as {
			messageId: string;
			text: string;
		};
		expect(assistant.text).toBe("Here is the process.");
		expect(durable[1]?.payload).toEqual({
			messageId: assistant.messageId,
			version: 1,
			payload: uiInput,
		});
		const expectedUiEvent = {
			type: EventType.CUSTOM,
			name: "mymemo.generative_ui",
			value: {
				eventId: `run-1:${durable[1]?.seq}`,
				messageId: assistant.messageId,
				version: 1,
				payload: uiInput,
			},
		} satisfies LiveStreamEvent;
		for (const events of [original, reconnect]) {
			expect(events.filter(({ type }) => type === "CUSTOM")).toEqual([
				expectedUiEvent,
			]);
			expect(
				events.some(({ type }) => type.toString().startsWith("TOOL_CALL")),
			).toBe(false);
		}
		expect(reconnect).toEqual(original);
		await relay.close();
	});

	it("retains a committed PresentUI payload when the Run terminalizes interrupted", async () => {
		const envelopeConsumed = Promise.withResolvers<void>();
		const querySettled = Promise.withResolvers<void>();
		const messages = toolEnvelope({
			toolUses: [
				{
					toolUseId: "toolu-ui-1",
					name: "mcp__mymemo-executor__PresentUI",
					input: {
						component: "diagram",
						props: { source: "flowchart LR\nA --> B" },
					},
				},
			],
		});
		const harness = buildHarness(async () => ({
			...noArtifactPublication,
			sessionEvidence: noSessionMirrorEvidence,
			close() {
				querySettled.resolve();
			},
			async interrupt() {
				querySettled.resolve();
			},
			async *[Symbol.asyncIterator]() {
				for (const message of messages) yield message;
				envelopeConsumed.resolve();
				await querySettled.promise;
			},
		}));
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await envelopeConsumed.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		await harness.drain();

		expect((await readRun("run-1"))?.status).toBe("interrupted");
		const durable = await readEvents("run-1");
		expect(durable.map(({ type }) => type)).toEqual([
			"assistant_message_completed",
			"ui_payload",
			"run_interrupted",
		]);
		const assistant = durable[0]?.payload as {
			messageId: string;
			text: string;
		};
		expect(assistant.text).toBe("");
		expect(durable[1]?.payload).toMatchObject({
			messageId: assistant.messageId,
			version: 1,
			payload: { component: "diagram" },
		});
	});

	it("does not publish a pointer from an SDK initialization id alone", async () => {
		const harness = buildHarness(async (_run, _signal, owner) => {
			const store = await createRuntimeSessionStoreFor(owner);
			return messageQuery([initMessage("session-initialized")], store);
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("done");
		expect(runtime?.agentSessionId).toBeNull();
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_done",
		]);
	});

	it("publishes the first pointer only when the bound store mirrored that main session", async () => {
		const harness = buildHarness(async (_run, _signal, owner) => {
			const store = await createRuntimeSessionStoreFor(owner);
			await store.append(
				{ projectKey: "project-1", sessionId: "session-proven" },
				[{ type: "user", uuid: "main-entry" } as SessionStoreEntry],
			);
			return messageQuery([resultMessage("session-proven")], store);
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("done");
		expect(runtime?.agentSessionId).toBe("session-proven");
	});

	it("does not publish a pointer from subagent-only mirroring", async () => {
		const harness = buildHarness(async (_run, _signal, owner) => {
			const store = await createRuntimeSessionStoreFor(owner);
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("done");
		expect(runtime?.agentSessionId).toBeNull();
	});

	it("commits one durable Assistant message for a complete provider envelope", async () => {
		const harness = buildHarness(async () =>
			messageQuery(textEnvelope({ completeText: "Hello there." })),
		);
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

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
		const harness = buildHarness(async () => messageQuery(messages));
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

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
			const harness = buildHarness(async () => messageQuery(fixture.messages));
			await seedQueuedRun(tdb.db, {
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
			});

			await harness.tick();
			await harness.drain();

			expect((await readRun("run-1"))?.status).toBe("error");
			const events = await readEvents("run-1");
			expect(events.map((event) => event.type)).toEqual(["run_error"]);
			expect(events[0]?.payload).toEqual({
				message: "Run failed",
				outcome: "error",
			});
		});
	}

	it("passes the acquired Run, abort signal, and Ownership epoch to startRunQuery", async () => {
		let seenRunId: string | undefined;
		let seenOwner: RunWriteOwner | undefined;
		let sawSignal = false;
		const harness = buildHarness(async (run, signal, owner) => {
			seenRunId = run.runId;
			seenOwner = owner;
			sawSignal = signal instanceof AbortSignal;
			return messageQuery(textEnvelope({ completeText: "ok" }));
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		expect(seenRunId).toBe("run-1");
		expect(sawSignal).toBe(true);
		expect(seenOwner).toMatchObject({
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});
		expect(seenOwner?.epoch).toBe(
			(await tdb.db.select().from(conversations))[0]?.epoch,
		);
	});

	it("fails fast on mirror_error without establishing a first session pointer", async () => {
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
		const harness = buildHarness(
			async (_run, signal, owner) => {
				await createRuntimeFor(owner);
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

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
		const started = Promise.withResolvers<void>();
		const releaseMirrorError = Promise.withResolvers<void>();
		const calls: string[] = [];
		const harness = buildHarness(async (_run, signal) => {
			signal.addEventListener("abort", () => calls.push("tool-abort"), {
				once: true,
			});
			return withNoSessionMirrorEvidence({
				...noArtifactPublication,
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		releaseMirrorError.resolve();
		await harness.drain();

		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_interrupted",
		]);
	});

	it("retains an existing session pointer after mirror_error", async () => {
		const harness = buildHarness(async (run, _signal, owner) => {
			await createRuntimeFor(owner);
			await tdb.db
				.update(conversationRuntime)
				.set({ agentSessionId: "session-existing" })
				.where(eq(conversationRuntime.conversationId, run.conversationId));
			return messageQuery([
				resultMessage("session-unreliable"),
				mirrorErrorMessage(),
			]);
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect(runtime?.agentSessionId).toBe("session-existing");
	});

	it("stops an interrupted Run cleanly inside the 30-second deadline", async () => {
		const started = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const calls: string[] = [];
		let deadlineMs: number | undefined;
		let deadlineCancelled = false;
		const harness = buildHarness(
			async (_run, signal) => {
				signal.addEventListener("abort", () => calls.push("tool-abort"), {
					once: true,
				});
				started.resolve();
				return withNoSessionMirrorEvidence({
					...noArtifactPublication,
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		await harness.drain();

		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect(deadlineMs).toBe(30_000);
		expect(deadlineCancelled).toBe(true);
		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_interrupted",
		]);
	});

	it("keeps renewing Ownership for a hung interrupted Run and force-closes it after the deadline", async () => {
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
		const harness = buildHarness(
			async (_run, signal, owner) => {
				const store = await createRuntimeSessionStoreFor(owner);
				await store.append(
					{ projectKey: "project-1", sessionId: "session-interrupted" },
					[{ type: "user", uuid: "main-entry" } as SessionStoreEntry],
				);
				signal.addEventListener("abort", () => calls.push("tool-abort"), {
					once: true,
				});
				started.resolve();
				return withSessionMirrorEvidence(
					{
						...noArtifactPublication,
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
					"session-interrupted",
				);
			},
			logger,
			deadline.startStopDeadline,
		);
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		await interrupted.promise;
		expect(await deadline.started).toBe(30_000);
		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect((await readRun("run-1"))?.status).toBe("interrupt_requested");

		await tdb.db
			.update(conversations)
			.set({ ownerUntil: new Date(Date.now() + 1_000) })
			.where(eq(conversations.conversationId, "conv-1"));
		await harness.tick();
		const [conversation] = await tdb.db.select().from(conversations);
		expect(conversation?.ownerUntil?.getTime()).toBeGreaterThan(
			Date.now() + 30_000,
		);
		expect(calls).toEqual(["tool-abort", "interrupt"]);

		deadline.elapse();
		await harness.drain();

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
		const started = Promise.withResolvers<void>();
		const releaseStream = Promise.withResolvers<void>();
		const deadline = virtualStopDeadline();
		const calls: string[] = [];
		const harness = buildHarness(
			async () => {
				started.resolve();
				return withNoSessionMirrorEvidence({
					...noArtifactPublication,
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		await started.promise;
		await tdb.db
			.update(conversations)
			.set({
				epoch: sql`${conversations.epoch} + 1`,
				ownerWorkerId: "worker-2",
				ownerUntil: new Date(Date.now() + 60_000),
			})
			.where(eq(conversations.conversationId, "conv-1"));
		await harness.tick();
		await Promise.resolve();

		expect(calls).toEqual(["close"]);
		releaseStream.resolve();
		await harness.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "running",
			executedByWorkerId: "worker-1",
		});
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("writes no terminal Outcome when the fence is lost after forced close", async () => {
		const started = Promise.withResolvers<void>();
		const closeCalled = Promise.withResolvers<void>();
		const releaseStream = Promise.withResolvers<void>();
		const deadline = virtualStopDeadline();
		const harness = buildHarness(
			async () =>
				withNoSessionMirrorEvidence({
					...noArtifactPublication,
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		await started.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		deadline.elapse();
		await closeCalled.promise;

		await lapseConversationOwnership(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
		});
		releaseStream.resolve();
		await harness.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "interrupt_requested",
			executedByWorkerId: "worker-1",
		});
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("force-closes a query-local infrastructure stop and maps it to error", async () => {
		const started = Promise.withResolvers<void>();
		const forceCloseController = new AbortController();
		const calls: string[] = [];
		const harness = buildHarness(
			async () =>
				withNoSessionMirrorEvidence({
					...noArtifactPublication,
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await started.promise;
		forceCloseController.abort();
		await harness.drain();

		expect(calls).toEqual(["close"]);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
	});

	it("maps worker shutdown of a supervised query to error", async () => {
		const started = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const calls: string[] = [];
		let deadlines = 0;
		const harness = buildHarness(
			async (_run, _signal) =>
				withNoSessionMirrorEvidence({
					...noArtifactPublication,
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await harness.tick();
		await started.promise;

		await harness.stop();

		expect(calls).toEqual(["close"]);
		expect(deadlines).toBe(0);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
	});

	for (const lateResult of ["success", "error"] as const) {
		it(`lets durable interruption beat a late SDK ${lateResult}`, async () => {
			const started = Promise.withResolvers<void>();
			const stopped = Promise.withResolvers<void>();
			const deadline = virtualStopDeadline();
			const harness = buildHarness(
				async () =>
					withNoSessionMirrorEvidence({
						...noArtifactPublication,
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
			await seedQueuedRun(tdb.db, {
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
			});
			await harness.tick();
			await started.promise;
			await requestRunInterruptionTx(tdb.db, {
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
			});

			await harness.tick();
			await harness.drain();

			expect((await readRun("run-1"))?.status).toBe("interrupted");
			expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
				"run_interrupted",
			]);
		});
	}

	it("terminalizes an SDK failure with the generic client message", async () => {
		const incomplete = textEnvelope({ completeText: "partial" }).slice(0, 4);
		const harness = buildHarness(async () =>
			stepQuery([...incomplete, { throw: new Error("model exploded") }]),
		);
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

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

	it("preserves mirrored continuity when a thrown failure reconciles to interruption", async () => {
		const harness = buildHarness(async (run, _signal, owner) => {
			const store = await createRuntimeSessionStoreFor(owner);
			await store.append(
				{ projectKey: "project-1", sessionId: "session-reconciled" },
				[{ type: "user", uuid: "main-entry" } as SessionStoreEntry],
			);
			// Land the durable request after the harness's last heartbeat so local
			// interruption state remains false and the error CAS must reconcile.
			await requestRunInterruptionTx(tdb.db, {
				runId: run.runId,
				userId: run.userId,
				conversationId: run.conversationId,
			});
			return stepQuery([{ throw: new Error("sandbox renewal failed") }], store);
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect(runtime?.agentSessionId).toBe("session-reconciled");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_interrupted",
		]);
	});

	it("records one error outcome for an SDK error result followed by rejection", async () => {
		const incomplete = textEnvelope({ completeText: "partial" }).slice(0, 4);
		const harness = buildHarness(async () =>
			stepQuery([
				...incomplete,
				errorResultMessage("provider rejected the request"),
				{ throw: new Error("iterator rejected after error result") },
			]),
		);
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		const events = await readEvents("run-1");
		expect(events.map((event) => event.type)).toEqual(["run_error"]);
		expect(JSON.stringify(events[0]?.payload)).not.toContain("provider");
	});

	it("advances the agent-session pointer only after a valid successful stream", async () => {
		const harness = buildHarness(async (_run, _signal, owner) => {
			await createRuntimeFor(owner);
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
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("done");
		expect(runtime?.agentSessionId).toBe("session-valid");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("does not advance the agent-session pointer for an invalid envelope", async () => {
		const harness = buildHarness(async (_run, _signal, owner) => {
			await createRuntimeFor(owner);
			return messageQuery([
				...textEnvelope({ completeText: "uncommitted" }).slice(0, -1),
				resultMessage("session-invalid"),
			]);
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await harness.tick();
		await harness.drain();

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		expect((await readRun("run-1"))?.status).toBe("error");
		expect(runtime?.agentSessionId).toBeNull();
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_error",
		]);
	});
});
