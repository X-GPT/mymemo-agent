import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { conversationMessages, conversations } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import { asc } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "@/deps";
import { PostgresConversationStore } from "@/features/conversation-store/postgres-conversation-store";
import { type AgentQueryChatDeps, createAiChatRoutes } from "./ai-chat.route";
import { PostgresChatMessageStore } from "./postgres-chat-message-store";

type MessageStore = AgentQueryChatDeps["messageStore"];
type RuntimeInvoker = AgentQueryChatDeps["runtimeInvoker"];

const identityHeaders = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

function input(overrides: Record<string, unknown> = {}) {
	return {
		id: "conversation-1",
		messages: [
			{
				id: "user-message-1",
				role: "user",
				parts: [{ type: "text", text: "Tell me something" }],
			},
		],
		model: "anthropic/claude-sonnet-5",
		trigger: "submit-message",
		...overrides,
	};
}

function parseAiSdkSse(text: string): unknown[] {
	return text
		.trim()
		.split("\n\n")
		.map((block) => block.slice("data: ".length))
		.map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

async function listPersistedMessages(tdb: TestDb) {
	const rows = await tdb.db
		.select({
			id: conversationMessages.messageId,
			role: conversationMessages.role,
			parts: conversationMessages.parts,
		})
		.from(conversationMessages)
		.orderBy(asc(conversationMessages.sequence));
	return rows;
}

function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
	} as unknown as SDKMessage;
}

function resultEvent(overrides: Record<string, unknown> = {}): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "provider-only terminal echo",
		session_id: "agent-session-1",
		...overrides,
	} as SDKMessage;
}

function successfulClaudeEvents(): SDKMessage[] {
	return [
		streamEvent({
			type: "message_start",
			message: { id: "provider-message-1", content: [] },
		}),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "A direct " },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "answer." },
		}),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_stop" }),
		resultEvent(),
	];
}

function buildApp(
	store: MessageStore,
	runtimeInvoker: RuntimeInvoker,
	exposureGate = {
		async isAgentEnabled() {
			return true;
		},
	},
) {
	const app = new Hono<AppEnv>();
	app.route(
		"/api/chat",
		createAiChatRoutes({
			messageStore: store,
			runtimeInvoker,
			exposureGate,
			createMessageId: () => "assistant-message-1",
		}),
	);
	return app;
}

describe("injected Agent-query POST /api/chat", () => {
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
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			epoch: 7,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
		});
	});

	it("persists the User before direct invocation and the complete Assistant through onEnd", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		const requests: AgentQueryRequest[] = [];
		const runtimeInvoker = {
			async invoke(request: AgentQueryRequest) {
				requests.push(request);
				expect(await listPersistedMessages(tdb)).toEqual([
					{
						id: "user-message-1",
						role: "user",
						parts: [{ type: "text", text: "Tell me something" }],
					},
				]);
				return successfulClaudeEvents();
			},
		};
		const app = buildApp(store, runtimeInvoker);

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(requests).toEqual([
			{
				version: 1,
				conversationId: "conversation-1",
				conversationEpoch: 7,
				prompt: "Tell me something",
				model: "anthropic/claude-sonnet-5",
			},
		]);
		expect(parseAiSdkSse(await response.text())).toEqual([
			{ type: "start", messageId: "assistant-message-1" },
			{ type: "text-start", id: "assistant-message-1-text" },
			{
				type: "text-delta",
				id: "assistant-message-1-text",
				delta: "A direct ",
			},
			{
				type: "text-delta",
				id: "assistant-message-1-text",
				delta: "answer.",
			},
			{ type: "text-end", id: "assistant-message-1-text" },
			{ type: "finish", finishReason: "stop" },
			"[DONE]",
		]);
		expect(await listPersistedMessages(tdb)).toEqual([
			{
				id: "user-message-1",
				role: "user",
				parts: [{ type: "text", text: "Tell me something" }],
			},
			{
				id: "assistant-message-1",
				role: "assistant",
				parts: [{ type: "text", text: "A direct answer.", state: "done" }],
			},
		]);

		const conversation = await new PostgresConversationStore(tdb.db).get({
			userId: "member-1",
			conversationId: "conversation-1",
		});
		expect(conversation?.title).toBe("Tell me something");
		expect(conversation?.lastActivityAt.getTime()).toBeGreaterThan(
			new Date("2026-01-01T00:00:00.000Z").getTime(),
		);
	});

	it("does not expose finish until onEnd persistence commits", async () => {
		const postgresStore = new PostgresChatMessageStore(tdb.db);
		let persistenceStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			persistenceStarted = resolve;
		});
		let releasePersistence!: () => void;
		const persistenceGate = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		const store: MessageStore = {
			ownedConversationExists: (ref) =>
				postgresStore.ownedConversationExists(ref),
			admitUserMessage: (ref, message) =>
				postgresStore.admitUserMessage(ref, message),
			async persistAssistantMessage(ref, message) {
				persistenceStarted();
				await persistenceGate;
				await postgresStore.persistAssistantMessage(ref, message);
			},
		};
		const app = buildApp(store, {
			async invoke() {
				return successfulClaudeEvents();
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected response body");
		const decoder = new TextDecoder();
		let responseText = "";
		const consume = (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				responseText += decoder.decode(value, { stream: true });
			}
		})();

		await started;
		expect(responseText).toContain('"type":"text-end"');
		expect(responseText).not.toContain('"type":"finish"');
		releasePersistence();
		await consume;
		expect(responseText).toContain('"type":"finish","finishReason":"stop"');
	});

	it("does not persist a partial Assistant when the client aborts", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		let releaseRuntime!: () => void;
		const runtimeGate = new Promise<void>((resolve) => {
			releaseRuntime = resolve;
		});
		let runtimeFinished!: () => void;
		const finished = new Promise<void>((resolve) => {
			runtimeFinished = resolve;
		});
		const app = buildApp(store, {
			async invoke() {
				return {
					async *[Symbol.asyncIterator]() {
						const events = successfulClaudeEvents();
						try {
							for (const event of events.slice(0, 3)) yield event;
							await runtimeGate;
							for (const event of events.slice(3)) yield event;
						} finally {
							runtimeFinished();
						}
					},
				};
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected response body");
		let responseText = "";
		const decoder = new TextDecoder();
		while (!responseText.includes("A direct ")) {
			const { done, value } = await reader.read();
			if (done) throw new Error("response ended before partial text");
			responseText += decoder.decode(value, { stream: true });
		}

		await reader.cancel();
		releaseRuntime();
		await finished;
		expect(await listPersistedMessages(tdb)).toEqual([
			{
				id: "user-message-1",
				role: "user",
				parts: [{ type: "text", text: "Tell me something" }],
			},
		]);
	});

	it("keeps the initial title and advances activity for each later User message", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		const app = buildApp(store, {
			async invoke() {
				return successfulClaudeEvents();
			},
		});
		const conversationStore = new PostgresConversationStore(tdb.db);
		const first = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		await first.text();
		const afterFirst = await conversationStore.get({
			userId: "member-1",
			conversationId: "conversation-1",
		});

		const second = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(
				input({
					messages: [
						{
							id: "user-message-2",
							role: "user",
							parts: [{ type: "text", text: "A later question" }],
						},
					],
				}),
			),
		});
		await second.text();
		const afterSecond = await conversationStore.get({
			userId: "member-1",
			conversationId: "conversation-1",
		});

		expect(afterSecond?.title).toBe("Tell me something");
		expect(afterSecond?.lastActivityAt.getTime()).toBeGreaterThan(
			afterFirst?.lastActivityAt.getTime() ?? 0,
		);
	});

	it("strictly accepts exactly one initial text-only User UIMessage", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		let invocations = 0;
		const app = buildApp(store, {
			async invoke() {
				invocations++;
				return successfulClaudeEvents();
			},
		});
		const invalidBodies = [
			input({ messages: [] }),
			input({ messages: [input().messages[0], input().messages[0]] }),
			input({
				messages: [
					{
						id: "assistant-input",
						role: "assistant",
						parts: [{ type: "text", text: "no" }],
					},
				],
			}),
			input({
				messages: [
					{
						id: "user-message-1",
						role: "user",
						parts: [{ type: "text", text: "" }],
					},
				],
			}),
			input({
				messages: [
					{
						id: "invalid/id",
						role: "user",
						parts: [{ type: "text", text: "no" }],
					},
				],
			}),
			input({
				messages: [
					{
						id: "user-message-1",
						role: "user",
						parts: [
							{ type: "text", text: "one" },
							{ type: "text", text: "two" },
						],
					},
				],
			}),
			input({
				messages: [
					{
						id: "user-message-1",
						role: "user",
						parts: [{ type: "file", mediaType: "text/plain", url: "data:,no" }],
					},
				],
			}),
			input({ extra: true }),
			input({ trigger: "regenerate-message" }),
		];

		for (const body of invalidBodies) {
			const response = await app.request("/api/chat", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: "Invalid AI SDK chat input",
			});
		}
		expect(invocations).toBe(0);
		expect(await listPersistedMessages(tdb)).toEqual([]);
	});

	it("keeps missing and foreign Conversations owner-private", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		let invocations = 0;
		const app = buildApp(store, {
			async invoke() {
				invocations++;
				return successfulClaudeEvents();
			},
		});
		for (const request of [
			{
				headers: { ...identityHeaders, "x-member-code": "member-2" },
				body: input(),
			},
			{
				headers: identityHeaders,
				body: input({ id: "missing-conversation" }),
			},
		]) {
			const response = await app.request("/api/chat", {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify(request.body),
			});
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: "Conversation not found",
			});
		}
		expect(invocations).toBe(0);
		expect(await listPersistedMessages(tdb)).toEqual([]);

		const deniedApp = buildApp(
			store,
			{
				async invoke() {
					return successfulClaudeEvents();
				},
			},
			{
				async isAgentEnabled() {
					return false;
				},
			},
		);
		const deniedForeign = await deniedApp.request("/api/chat", {
			method: "POST",
			headers: { ...identityHeaders, "x-member-code": "member-2" },
			body: JSON.stringify(input()),
		});
		expect(deniedForeign.status).toBe(404);
		expect(await deniedForeign.json()).toEqual({
			error: "Conversation not found",
		});
	});

	it("rejects models outside the Chat API allowlist before persistence", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		let invocations = 0;
		const app = buildApp(store, {
			async invoke() {
				invocations++;
				return successfulClaudeEvents();
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input({ model: "provider/raw-model" })),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Unsupported model" });
		expect(invocations).toBe(0);
		expect(await listPersistedMessages(tdb)).toEqual([]);
	});

	it("applies the new-work exposure gate before persistence", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		let invocations = 0;
		const app = buildApp(
			store,
			{
				async invoke() {
					invocations++;
					return successfulClaudeEvents();
				},
			},
			{
				async isAgentEnabled() {
					return false;
				},
			},
		);

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Agent is not enabled" });
		expect(invocations).toBe(0);
		expect(await listPersistedMessages(tdb)).toEqual([]);
	});

	it("rejects a duplicate User message id without reinvoking or changing activity", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		let invocations = 0;
		const app = buildApp(store, {
			async invoke() {
				invocations++;
				return successfulClaudeEvents();
			},
		});
		const first = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		await first.text();
		const conversationStore = new PostgresConversationStore(tdb.db);
		const activityAfterFirst = (
			await conversationStore.get({
				userId: "member-1",
				conversationId: "conversation-1",
			})
		)?.lastActivityAt;

		const duplicate = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});

		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual({
			error: "Message id was already used",
		});
		expect(invocations).toBe(1);
		expect(
			(
				await conversationStore.get({
					userId: "member-1",
					conversationId: "conversation-1",
				})
			)?.lastActivityAt,
		).toEqual(activityAfterFirst);
	});

	const failureScenarios: Array<{
		name: string;
		invoker: () => RuntimeInvoker;
	}> = [
		{
			name: "Runtime rejection",
			invoker: () => ({
				async invoke() {
					throw new Error(
						"private Runtime rejection with prompt and Tool data",
					);
				},
			}),
		},
		{
			name: "premature EOF",
			invoker: () => ({
				async invoke() {
					return successfulClaudeEvents().slice(0, -1);
				},
			}),
		},
		{
			name: "partial-stream failure",
			invoker: () => ({
				async invoke() {
					return {
						async *[Symbol.asyncIterator]() {
							for (const event of successfulClaudeEvents().slice(0, 3)) {
								yield event;
							}
							throw new Error("raw provider partial-stream failure");
						},
					};
				},
			}),
		},
		{
			name: "terminal Claude failure",
			invoker: () => ({
				async invoke() {
					return [
						...successfulClaudeEvents().slice(0, -1),
						resultEvent({
							subtype: "error_during_execution",
							is_error: true,
							errors: ["private provider terminal error"],
							session_id: "private-session-id",
						}),
					];
				},
			}),
		},
		{
			name: "translation failure",
			invoker: () => ({
				async invoke() {
					return [
						successfulClaudeEvents()[0] as SDKMessage,
						streamEvent({
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								name: "PrivateTool",
								input: { prompt: "private prompt" },
							},
						}),
					];
				},
			}),
		},
	];

	for (const scenario of failureScenarios) {
		it(`retains only the User message and emits a generic error on ${scenario.name}`, async () => {
			const store = new PostgresChatMessageStore(tdb.db);
			const app = buildApp(store, scenario.invoker());

			const response = await app.request("/api/chat", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify(input()),
			});
			const responseText = await response.text();

			expect(response.status).toBe(200);
			expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
			expect(responseText).toContain(
				'"type":"error","errorText":"Response failed"',
			);
			expect(responseText).not.toContain("private");
			expect(responseText).not.toContain("Tool");
			expect(responseText).not.toContain("session-id");
			expect(responseText).not.toContain("Tell me something");
			expect(await listPersistedMessages(tdb)).toEqual([
				{
					id: "user-message-1",
					role: "user",
					parts: [{ type: "text", text: "Tell me something" }],
				},
			]);
		});
	}

	it("omits the Assistant and exposes only a generic error when completion persistence fails", async () => {
		const postgresStore = new PostgresChatMessageStore(tdb.db);
		const store: MessageStore = {
			ownedConversationExists: (ref) =>
				postgresStore.ownedConversationExists(ref),
			admitUserMessage: (ref, message) =>
				postgresStore.admitUserMessage(ref, message),
			async persistAssistantMessage() {
				throw new Error("private database and session persistence failure");
			},
		};
		const app = buildApp(store, {
			async invoke() {
				return successfulClaudeEvents();
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		const responseText = await response.text();

		expect(responseText).toContain(
			'"type":"error","errorText":"Response failed"',
		);
		expect(responseText).not.toContain('"type":"finish"');
		expect(responseText).not.toContain("private");
		expect(await listPersistedMessages(tdb)).toEqual([
			{
				id: "user-message-1",
				role: "user",
				parts: [{ type: "text", text: "Tell me something" }],
			},
		]);
	});
});
