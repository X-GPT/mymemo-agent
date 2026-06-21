import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AppDeps } from "@/deps";
import type { RunEvent, RunRef } from "@/features/workspace-store";
import type { EventMessage, MymemoEvent } from "./chat.events";
import { ChatLogger } from "./chat.logger";
import type { MymemoEventSender } from "./chat.streaming";
import { runEventToClientEvents } from "./run-events-to-sse";

// Orchestration is mocked so no sandbox, gateway, database, or provider call is
// made; a swappable impl lets each test drive success/failure behavior.
type RunOpts = {
	onSandboxId: (id: string) => Promise<void>;
	onAgentSessionId: (id: string) => Promise<void>;
	onTextDelta: (text: string) => Promise<void>;
	onTextEnd: () => Promise<void>;
};

let runSandboxChatImpl: (opts: RunOpts) => Promise<unknown>;

class FakeConversationBusyError extends Error {}

mock.module("@/features/sandbox-orchestration", () => ({
	runSandboxChat: (_deps: unknown, opts: RunOpts) => runSandboxChatImpl(opts),
	ConversationBusyError: FakeConversationBusyError,
}));

const { complete } = await import("./chat.controller");

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
	} as unknown as AppDeps;
	return { deps, runEvents };
}

const logger = new ChatLogger(
	{ info() {}, warn() {}, error() {} } as never,
	"member-1",
);

const request = {
	chatContent: "hi",
	conversationId: "conv-1",
	memberCode: "member-1",
	partnerCode: "partner-1",
} as never;

describe("complete", () => {
	beforeEach(() => {
		runSandboxChatImpl = async (opts) => {
			await opts.onSandboxId("sbx-1");
			await opts.onAgentSessionId("agent-sess-1");
			await opts.onTextDelta("Hello");
			await opts.onTextEnd();
			return { status: "completed" };
		};
	});

	it("streams the success ordering ending in done", async () => {
		const { sender, types } = fakeSender();
		const { deps } = fakeDeps();

		await complete(deps, request, sender, logger);

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

		await complete(deps, request, sender, logger);

		// The client stream is exactly the projection of the recorded run events.
		expect(messages).toEqual(runEvents.flatMap(runEventToClientEvents));
		// And the recorded log is the full lifecycle, in order.
		expect(runEvents.map((e) => e.type)).toEqual([
			"run_started",
			"sandbox_leased",
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

		await complete(deps, request, sender, logger);

		expect(types()).toEqual([
			"conversation_id",
			"run_id",
			"sandbox_id",
			"text_delta",
			"error",
		]);
		expect(types()).not.toContain("done");
		const errorFrame = messages.at(-1);
		expect(errorFrame).toEqual({ type: "error", message: "daemon exploded" });
	});

	it("surfaces a friendly message when the conversation is busy", async () => {
		runSandboxChatImpl = async () => {
			throw new FakeConversationBusyError("raw busy");
		};
		const { sender, messages } = fakeSender();
		const { deps } = fakeDeps();

		await complete(deps, request, sender, logger);

		expect(messages.at(-1)).toEqual({
			type: "error",
			message:
				"Sandbox is busy processing another request. Please try again shortly.",
		});
	});
});
