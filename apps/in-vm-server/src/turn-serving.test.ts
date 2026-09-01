import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { conversationMessages, conversations } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { claimNextTurnTx, enqueueTurnTx } from "@mymemo/agent-db/turn-store";
import {
	createInMemoryTurnLiveStreamRelay,
	type TurnLiveStreamRelay,
} from "@mymemo/live-text";
import type { UIMessageChunk } from "ai";
import { and, eq } from "drizzle-orm";
import {
	resultError,
	resultSuccess,
	streamEvent,
	textStep,
	toolResultMessage,
	toolStep,
} from "./testing/sdk-fixtures";
import {
	promptFromParts,
	serveOneTurn,
	type TurnServingDeps,
} from "./turn-serving";

const USER_ID = "vm-user";
const CONVERSATION_ID = "vm-conversation";
const TURN_ID = "turn-1";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values({
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		scope: "general",
	});
});

const silentLogger = { info() {}, warn() {}, error() {} };
const SENTINEL_OPTIONS = { model: "sentinel" } as Options;

async function enqueue(text = "hello world", messageId = TURN_ID) {
	await enqueueTurnTx(tdb.db, {
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		messageId,
		parts: [{ type: "text", text }],
	});
}

function scriptedQuery(messages: SDKMessage[], calls?: unknown[]) {
	return (params: { prompt: string; options: Options }) => {
		calls?.push(params);
		return (async function* () {
			yield* messages;
		})();
	};
}

function makeDeps(overrides: Partial<TurnServingDeps>): TurnServingDeps {
	return {
		db: tdb.db,
		relay: createInMemoryTurnLiveStreamRelay(),
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		query: scriptedQuery([...textStep("hi"), resultSuccess()]),
		queryOptions: SENTINEL_OPTIONS,
		logger: silentLogger,
		...overrides,
	};
}

async function loadTurnRow(messageId = TURN_ID) {
	const [row] = await tdb.db
		.select()
		.from(conversationMessages)
		.where(
			and(
				eq(conversationMessages.userId, USER_ID),
				eq(conversationMessages.messageId, messageId),
			),
		);
	if (!row) throw new Error(`turn ${messageId} not found`);
	return row;
}

async function loadAssistantRows() {
	return await tdb.db
		.select()
		.from(conversationMessages)
		.where(
			and(
				eq(conversationMessages.userId, USER_ID),
				eq(conversationMessages.conversationId, CONVERSATION_ID),
				eq(conversationMessages.role, "assistant"),
			),
		);
}

/** Subscribe to the Turn's live channel and collect chunks until terminal. */
function collectLiveChunks(
	relay: TurnLiveStreamRelay,
): Promise<UIMessageChunk[]> & { ready: Promise<void> } {
	const controller = new AbortController();
	const subscribed = relay.subscribe(TURN_ID, controller.signal);
	const collected = (async () => {
		const chunks: UIMessageChunk[] = [];
		for await (const serialized of await subscribed) {
			chunks.push(JSON.parse(serialized) as UIMessageChunk);
		}
		return chunks;
	})() as Promise<UIMessageChunk[]> & { ready: Promise<void> };
	collected.ready = subscribed.then(() => {});
	return collected;
}

describe("serveOneTurn — the idempotent nudge no-op", () => {
	it("returns null when nothing is queued", async () => {
		const deps = makeDeps({});
		expect(await serveOneTurn(deps)).toBeNull();
	});

	it("returns null while a Turn is already processing", async () => {
		await enqueue("first", "turn-a");
		await enqueue("second", "turn-b");
		await claimNextTurnTx(tdb.db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		const calls: unknown[] = [];
		const deps = makeDeps({ query: scriptedQuery([], calls) });
		expect(await serveOneTurn(deps)).toBeNull();
		expect(calls).toEqual([]);
		expect((await loadTurnRow("turn-b")).status).toBe("queued");
	});
});

describe("serveOneTurn — a full Turn", () => {
	const fullStream: SDKMessage[] = [
		...textStep("Let me check."),
		...toolStep({
			toolUseId: "toolu_1",
			toolName: "Bash",
			toolInput: { command: "ls" },
		}),
		toolResultMessage("toolu_1", "notes.md"),
		...textStep("You have notes.md."),
		resultSuccess(),
	];

	it("terminalizes done and persists ONE assistant UIMessage with step and tool parts", async () => {
		await enqueue();
		const calls: { prompt: string; options: Options }[] = [];
		const deps = makeDeps({ query: scriptedQuery(fullStream, calls) });

		expect(await serveOneTurn(deps)).toBe("done");

		const turn = await loadTurnRow();
		expect(turn.status).toBe("done");
		expect(turn.startedAt).toBeInstanceOf(Date);
		expect(turn.finishedAt).toBeInstanceOf(Date);

		const assistants = await loadAssistantRows();
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.parts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "Let me check.", state: "done" },
			{ type: "step-start" },
			{
				type: "tool-Bash",
				toolCallId: "toolu_1",
				state: "output-available",
				input: { command: "ls" },
				output: "notes.md",
			},
			{ type: "step-start" },
			{ type: "text", text: "You have notes.md.", state: "done" },
		]);

		// The SDK query got the Turn's text as prompt and the confinement
		// bundle exactly as composed.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.prompt).toBe("hello world");
		expect(calls[0]?.options).toBe(SENTINEL_OPTIONS);
	});

	it("publishes the stock UIMessage chunk stream and terminates on finish", async () => {
		await enqueue();
		const relay = createInMemoryTurnLiveStreamRelay();
		const deps = makeDeps({ relay, query: scriptedQuery(fullStream) });

		const chunks = collectLiveChunks(relay);
		await chunks.ready;
		expect(await serveOneTurn(deps)).toBe("done");

		const received = await chunks;
		expect(received.map((chunk) => chunk.type)).toEqual([
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"start-step",
			"tool-input-start",
			"tool-input-available",
			"finish-step",
			"tool-output-available",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"finish",
		]);

		const start = received[0];
		if (start?.type !== "start") throw new Error("expected start");
		expect(start.messageId).toBe((await loadAssistantRows())[0]?.messageId);

		const finish = received.at(-1);
		if (finish?.type !== "finish") throw new Error("expected finish");
		expect(finish.messageMetadata).toEqual({ status: "done" });
	});
});

describe("serveOneTurn — commit-before-publish", () => {
	interface PublishProbe {
		chunkType: string;
		durableParts: unknown;
		turnStatus: string | null;
	}

	/** A relay whose publisher snapshots the database at each publish, so the
	 * test observes what was durable at the moment a chunk went out. */
	function probeRelay(probes: PublishProbe[]): TurnLiveStreamRelay {
		return {
			openPublisher: () => ({
				async publish(chunk: unknown) {
					const assistants = await loadAssistantRows();
					const turn = await loadTurnRow();
					probes.push({
						chunkType: (chunk as UIMessageChunk).type,
						durableParts: assistants[0]?.parts ?? null,
						turnStatus: turn.status,
					});
				},
				async close() {},
			}),
			subscribe: () => Promise.reject(new Error("unused")),
			close: async () => {},
		};
	}

	it("a finish-step never precedes its upsert; the terminal never precedes the status flip", async () => {
		await enqueue();
		const probes: PublishProbe[] = [];
		const deps = makeDeps({
			relay: probeRelay(probes),
			query: scriptedQuery([
				...textStep("step one"),
				...textStep("step two"),
				resultSuccess(),
			]),
		});

		expect(await serveOneTurn(deps)).toBe("done");

		const finishSteps = probes.filter((p) => p.chunkType === "finish-step");
		expect(finishSteps).toHaveLength(2);
		// First Step's completion chunk: the row already holds Step 1.
		expect(finishSteps[0]?.durableParts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "step one", state: "done" },
		]);
		// Second Step's completion chunk: the row already holds both Steps.
		expect(finishSteps[1]?.durableParts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "step one", state: "done" },
			{ type: "step-start" },
			{ type: "text", text: "step two", state: "done" },
		]);

		const terminal = probes.at(-1);
		expect(terminal?.chunkType).toBe("finish");
		// The terminal chunk went out only after the Outcome was durable.
		expect(terminal?.turnStatus).toBe("done");

		// And while the Turn was still streaming, the status was processing.
		expect(probes[0]?.chunkType).toBe("start");
		expect(probes[0]?.turnStatus).toBe("processing");
		expect(probes[0]?.durableParts).toBeNull();
	});
});

describe("serveOneTurn — failure retains exactly the completed Steps", () => {
	it("a model error terminalizes error, discarding the Step in flight", async () => {
		await enqueue();
		const relay = createInMemoryTurnLiveStreamRelay();
		const deps = makeDeps({
			relay,
			query: scriptedQuery([
				...textStep("committed step"),
				// A second Step begins but never completes.
				streamEvent({ type: "message_start", message: { id: "m2" } }),
				streamEvent({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
				streamEvent({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "provisional text" },
				}),
				resultError(["the provider went away"]),
			]),
		});

		const chunks = collectLiveChunks(relay);
		await chunks.ready;
		expect(await serveOneTurn(deps)).toBe("error");

		expect((await loadTurnRow()).status).toBe("error");
		const assistants = await loadAssistantRows();
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.parts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "committed step", state: "done" },
		]);

		const received = await chunks;
		const terminal = received.at(-1);
		expect(terminal).toEqual({
			type: "error",
			errorText: "the provider went away",
		});
	});

	it("a thrown stream failure terminalizes error with the committed Steps", async () => {
		await enqueue();
		const relay = createInMemoryTurnLiveStreamRelay();
		const deps = makeDeps({
			relay,
			query: () =>
				(async function* () {
					yield* textStep("survived");
					throw new Error("the CLI process died");
				})(),
		});

		const chunks = collectLiveChunks(relay);
		await chunks.ready;
		expect(await serveOneTurn(deps)).toBe("error");

		expect((await loadTurnRow()).status).toBe("error");
		expect((await loadAssistantRows())[0]?.parts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "survived", state: "done" },
		]);
		// No internal detail leaks onto the client stream.
		expect((await chunks).at(-1)).toEqual({
			type: "error",
			errorText: "The Turn ended in error.",
		});
	});

	it("a stream that ends without a result terminalizes error", async () => {
		await enqueue();
		const deps = makeDeps({ query: scriptedQuery(textStep("no result")) });
		expect(await serveOneTurn(deps)).toBe("error");
		expect((await loadTurnRow()).status).toBe("error");
	});

	it("a Turn with no text parts terminalizes error without spawning the CLI", async () => {
		await enqueueTurnTx(tdb.db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			messageId: TURN_ID,
			parts: [{ type: "data-widget", data: {} }],
		});
		const calls: unknown[] = [];
		const deps = makeDeps({ query: scriptedQuery([], calls) });

		expect(await serveOneTurn(deps)).toBe("error");
		expect(calls).toEqual([]);
		expect((await loadTurnRow()).status).toBe("error");
		// Nothing completed, so no assistant row is fabricated.
		expect(await loadAssistantRows()).toEqual([]);
	});
});

describe("serveOneTurn — relay failure degrades live delivery only", () => {
	it("still serves the Turn durably when every publish fails", async () => {
		await enqueue();
		const failingRelay: TurnLiveStreamRelay = {
			openPublisher: () => ({
				publish: () => Promise.reject(new Error("redis down")),
				close: async () => {},
			}),
			subscribe: () => Promise.reject(new Error("unused")),
			close: async () => {},
		};
		const deps = makeDeps({ relay: failingRelay });

		expect(await serveOneTurn(deps)).toBe("done");
		expect((await loadTurnRow()).status).toBe("done");
		expect(await loadAssistantRows()).toHaveLength(1);
	});
});

describe("promptFromParts", () => {
	it("joins the text parts", () => {
		expect(
			promptFromParts([
				{ type: "text", text: "one" },
				{ type: "data-widget", data: {} },
				{ type: "text", text: "two" },
			]),
		).toBe("one\n\ntwo");
	});

	it("returns empty for non-arrays and textless parts", () => {
		expect(promptFromParts(null)).toBe("");
		expect(promptFromParts([{ type: "file", url: "x" }])).toBe("");
	});
});
