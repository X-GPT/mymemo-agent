import { describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import type { RunRecord } from "@mymemo/agent-db/run-store";
import {
	createInMemoryLiveStreamRelay,
	createLiveStreamTelemetry,
	encodeAgUiLiveStreamEvent,
	type LiveStreamRelay,
} from "@mymemo/live-text";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type { ConversationRecord } from "@/features/conversation-store/conversation-store";
import type { RunStore } from "@/features/run-store/run-store";

const { createApp } = await import("@/app");

const conversation: ConversationRecord = {
	userId: "member-1",
	conversationId: "conv-1",
	scope: "general",
	collectionId: null,
	summaryId: null,
	title: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
	archivedAt: null,
};

const identityHeaders = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

const conversationStore = {
	async get() {
		return conversation;
	},
};

function runRecord(status: RunRecord["status"]): RunRecord {
	const now = new Date();
	return {
		runId: "user-message-1",
		userId: conversation.userId,
		conversationId: conversation.conversationId,
		normalizedInput: null,
		status,
		createdAt: now,
		updatedAt: now,
		executedByWorkerId: null,
		interruptRequestedAt: null,
		liveStreamFailedAt: null,
		nextEventSeq: 1,
		terminalAt: null,
	};
}

function buildApp(
	runStore: Partial<RunStore>,
	liveStreamRelay: LiveStreamRelay,
) {
	const deps = {
		config: {},
		conversationStore,
		exposureGate: {
			async isAgentEnabled() {
				return true;
			},
		},
		runStore,
		liveStreamRelay,
		liveStreamTelemetry: createLiveStreamTelemetry("chat-api", {
			info() {},
			warn() {},
		}),
	} as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as unknown as ApiConfig, deps);
}

function aiChatInput(parts: unknown[] = [{ type: "text", text: "hello" }]) {
	return {
		id: conversation.conversationId,
		messages: [{ id: "user-message-1", role: "user", parts }],
		trigger: "submit-message",
	};
}

async function relayWithEvents(runId: string, events: unknown[]) {
	const relay = createInMemoryLiveStreamRelay();
	const producer = await relay.openProducer(runId);
	for (const [index, event] of events.entries()) {
		const [chunk] = encodeAgUiLiveStreamEvent(event as never);
		if (!chunk) throw new Error("test event encoded empty");
		if (index === events.length - 1) await producer.publishTerminal(chunk);
		else await producer.append(chunk);
	}
	return { relay, producer };
}

function parseAiSdkSse(text: string): unknown[] {
	return text
		.trim()
		.split("\n\n")
		.map((block) => block.slice("data: ".length))
		.map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

describe("POST /api/chat", () => {
	it("admits the final AI SDK message and streams Assistant text", async () => {
		const admitted: unknown[] = [];
		const run = runRecord("queued");
		const runStore: Partial<RunStore> = {
			async admitRun(input) {
				admitted.push(input);
				return { outcome: "created", run };
			},
		};
		const { relay, producer } = await relayWithEvents(run.runId, [
			{ type: EventType.RUN_STARTED, threadId: "conv-1", runId: run.runId },
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: "assistant-1",
				role: "assistant",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "assistant-1",
				delta: "hi",
			},
			{ type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
			{ type: EventType.RUN_FINISHED, threadId: "conv-1", runId: run.runId },
		]);
		try {
			const response = await buildApp(runStore, relay).request("/api/chat", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify(aiChatInput()),
			});

			expect(response.status).toBe(200);
			expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
			expect(admitted).toEqual([
				{
					conversation,
					runId: "user-message-1",
					messageId: "user-message-1",
					message: "hello",
				},
			]);
			expect(parseAiSdkSse(await response.text())).toEqual([
				{ type: "start", messageId: "assistant-1" },
				{ type: "text-start", id: "assistant-1" },
				{ type: "text-delta", id: "assistant-1", delta: "hi" },
				{ type: "text-end", id: "assistant-1" },
				{ type: "finish", finishReason: "stop" },
				"[DONE]",
			]);
		} finally {
			await producer.close();
			await relay.close();
		}
	});

	it("streams an Outcome reached before a producer exists", async () => {
		const run = runRecord("queued");
		const runStore: Partial<RunStore> = {
			async admitRun() {
				return { outcome: "created", run };
			},
			async getRun() {
				return { ...run, status: "interrupted" };
			},
		};
		const relay = createInMemoryLiveStreamRelay();
		try {
			const response = await buildApp(runStore, relay).request("/api/chat", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify(aiChatInput()),
			});

			expect(parseAiSdkSse(await response.text())).toEqual([
				{ type: "abort" },
				"[DONE]",
			]);
		} finally {
			await relay.close();
		}
	});

	it("errors when a completed Run has no live producer", async () => {
		const run = runRecord("queued");
		const runStore: Partial<RunStore> = {
			async admitRun() {
				return { outcome: "created", run };
			},
			async getRun() {
				return { ...run, status: "done" };
			},
		};
		const relay = createInMemoryLiveStreamRelay();
		try {
			const response = await buildApp(runStore, relay).request("/api/chat", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify(aiChatInput()),
			});

			expect(parseAiSdkSse(await response.text())).toEqual([
				{ type: "error", errorText: "Live response unavailable" },
				{ type: "finish", finishReason: "error" },
				"[DONE]",
			]);
		} finally {
			await relay.close();
		}
	});

	it("rejects a non-text final message", async () => {
		const relay = createInMemoryLiveStreamRelay();
		try {
			const response = await buildApp({}, relay).request("/api/chat", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify(
					aiChatInput([
						{ type: "file", mediaType: "text/plain", url: "data:,hi" },
					]),
				),
			});
			expect(response.status).toBe(400);
		} finally {
			await relay.close();
		}
	});
});
