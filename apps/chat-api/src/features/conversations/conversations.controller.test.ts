import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationStore,
} from "@/features/conversation-store";
import type { EventMessage, MymemoEvent } from "@/features/streaming/events";
import { RequestLogger } from "@/features/streaming/logger";
import { runEventToClientEvents } from "@/features/streaming/run-events-to-sse";
import type { MymemoEventSender } from "@/features/streaming/sse-sender";
import type { RunEvent, RunRef } from "@/features/workspace-store";

// Orchestration is mocked so no sandbox, gateway, database, or provider call is
// made; a swappable impl lets each test drive success/failure behavior.
type RunOpts = {
	onSandboxId: (id: string) => Promise<void>;
	onDaemonStarted: () => Promise<void>;
	onAgentSessionId: (id: string) => Promise<void>;
	onTextDelta: (text: string) => Promise<void>;
};

let runSandboxChatImpl: (opts: RunOpts) => Promise<unknown>;

class FakeConversationBusyError extends Error {}
class FakeConversationScopeConflictError extends Error {}

mock.module("@/features/sandbox-orchestration", () => ({
	runSandboxChat: (_deps: unknown, opts: RunOpts) => runSandboxChatImpl(opts),
	ConversationBusyError: FakeConversationBusyError,
	ConversationScopeConflictError: FakeConversationScopeConflictError,
}));

const { createConversation, runConversationTurn } = await import(
	"./conversations.controller"
);

/** Captures every client SSE message in send order. */
function fakeSender() {
	const messages: EventMessage[] = [];
	const sender: MymemoEventSender = {
		async send(event: MymemoEvent) {
			messages.push(event.message);
		},
		async sendPing() {},
	};
	return { sender, messages, types: () => messages.map((m) => m.type) };
}

/** Captures every recorded run event in append order. */
function fakeDeps() {
	const runEvents: RunEvent[] = [];
	const workspaceStore = {
		async appendRunEvent(_ref: RunRef, event: RunEvent) {
			runEvents.push(event);
		},
	};
	const deps = {
		config: {},
		sandboxProvider: {},
		workspaceStore,
		conversationStore: null,
	} as unknown as AppDeps;
	return { deps, runEvents };
}

const logger = new RequestLogger(
	{ info() {}, warn() {}, error() {} } as never,
	"member-1",
);

const conversation: ConversationRecord = {
	userId: "member-1",
	conversationId: "conv-1",
	scope: "general",
	collectionId: null,
	summaryId: null,
};

describe("createConversation", () => {
	/** In-memory store capturing every created record. */
	function fakeStore() {
		const created: ConversationRecord[] = [];
		const store: ConversationStore = {
			async get() {
				return null;
			},
			async create(record) {
				created.push(record);
			},
		};
		return { store, created };
	}

	it("freezes general scope when no ids are given", async () => {
		const { store, created } = fakeStore();
		const result = await createConversation(
			store,
			{ memberCode: "member-1", partnerCode: "partner-1" },
			{},
		);

		expect(result.scope).toBe("general");
		expect(created[0]?.conversationId).toBe(result.conversationId);
		expect(created[0]).toMatchObject({
			userId: "member-1",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
	});

	it("freezes collection scope from collectionId", async () => {
		const { store, created } = fakeStore();
		const result = await createConversation(
			store,
			{ memberCode: "member-1", partnerCode: "partner-1" },
			{ collectionId: " col-9 " },
		);

		expect(result.scope).toBe("collection");
		expect(created[0]).toMatchObject({
			scope: "collection",
			collectionId: "col-9",
		});
	});

	it("freezes document scope from summaryId, taking precedence over collectionId", async () => {
		const { store, created } = fakeStore();
		const result = await createConversation(
			store,
			{ memberCode: "member-1", partnerCode: "partner-1" },
			{ collectionId: "col-9", summaryId: "sum-3" },
		);

		expect(result.scope).toBe("document");
		expect(created[0]).toMatchObject({
			scope: "document",
			collectionId: "col-9",
			summaryId: "sum-3",
		});
	});
});

describe("runConversationTurn", () => {
	beforeEach(() => {
		runSandboxChatImpl = async (opts) => {
			await opts.onSandboxId("sbx-1");
			await opts.onDaemonStarted();
			await opts.onAgentSessionId("agent-sess-1");
			await opts.onTextDelta("Hello");
			return { status: "completed" };
		};
	});

	it("streams the success ordering ending in done", async () => {
		const { sender, types } = fakeSender();
		const { deps } = fakeDeps();

		await runConversationTurn(
			deps,
			{ conversation, message: "hi" },
			sender,
			logger,
		);

		expect(types()).toEqual([
			"conversation_id",
			"run_id",
			"sandbox_id",
			"agent_session_id",
			"text_delta",
			"done",
		]);
	});

	it("derives every client frame from a recorded run event", async () => {
		const { sender, messages } = fakeSender();
		const { deps, runEvents } = fakeDeps();

		await runConversationTurn(
			deps,
			{ conversation, message: "hi" },
			sender,
			logger,
		);

		expect(messages).toEqual(runEvents.flatMap(runEventToClientEvents));
		expect(runEvents.map((e) => e.type)).toEqual([
			"run_started",
			"sandbox_leased",
			"daemon_started",
			"agent_event",
			"agent_event",
			"run_completed",
		]);
	});

	it("emits error and no done when orchestration fails", async () => {
		runSandboxChatImpl = async (opts) => {
			await opts.onSandboxId("sbx-1");
			await opts.onTextDelta("partial");
			throw new Error("daemon exploded");
		};
		const { sender, types, messages } = fakeSender();
		const { deps } = fakeDeps();

		await runConversationTurn(
			deps,
			{ conversation, message: "hi" },
			sender,
			logger,
		);

		expect(types()).toEqual([
			"conversation_id",
			"run_id",
			"sandbox_id",
			"text_delta",
			"error",
		]);
		expect(types()).not.toContain("done");
		expect(messages.at(-1)).toEqual({
			type: "error",
			message: "daemon exploded",
		});
	});

	it("surfaces a friendly message when the conversation is busy", async () => {
		runSandboxChatImpl = async () => {
			throw new FakeConversationBusyError("raw busy");
		};
		const { sender, messages } = fakeSender();
		const { deps } = fakeDeps();

		await runConversationTurn(
			deps,
			{ conversation, message: "hi" },
			sender,
			logger,
		);

		expect(messages.at(-1)).toEqual({
			type: "error",
			message:
				"Sandbox is busy processing another request. Please try again shortly.",
		});
	});

	it("surfaces a non-retryable message on a conversation scope conflict", async () => {
		runSandboxChatImpl = async () => {
			throw new FakeConversationScopeConflictError(
				"This conversation's document scope is fixed; start a new conversation to change it",
			);
		};
		const { sender, messages } = fakeSender();
		const { deps } = fakeDeps();

		await runConversationTurn(
			deps,
			{ conversation, message: "hi" },
			sender,
			logger,
		);

		// Not the "try again shortly" backpressure message — this can't be retried.
		expect(messages.at(-1)).toEqual({
			type: "error",
			message:
				"This conversation's document scope is fixed; start a new conversation to change it",
		});
	});

	it("forwards the frozen scope and ids from the conversation record", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const { deps } = fakeDeps();
		const docConversation: ConversationRecord = {
			userId: "member-1",
			conversationId: "conv-doc",
			scope: "document",
			collectionId: null,
			summaryId: "sum-7",
		};
		runSandboxChatImpl = async (opts: RunOpts & Record<string, unknown>) => {
			captured.push({
				scope: opts.scope,
				collectionId: opts.collectionId,
				summaryId: opts.summaryId,
			});
			await opts.onSandboxId("sbx-1");
			return { status: "completed" };
		};

		const { sender } = fakeSender();
		await runConversationTurn(
			deps,
			{ conversation: docConversation, message: "hi" },
			sender,
			logger,
		);

		expect(captured[0]).toEqual({
			scope: "document",
			collectionId: null,
			summaryId: "sum-7",
		});
	});
});
