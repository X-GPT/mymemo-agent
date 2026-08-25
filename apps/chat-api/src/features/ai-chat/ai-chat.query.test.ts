import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	conversationMessages,
	conversationRuntime,
	conversations,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import { asc } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "@/deps";
import { PostgresConversationStore } from "@/features/conversation-store/postgres-conversation-store";
import { type AgentQueryChatDeps, createAiChatRoutes } from "./ai-chat.route";
import {
	type ChatMessage,
	PostgresChatMessageStore,
} from "./postgres-chat-message-store";

type MessageStore = AgentQueryChatDeps["messageStore"];
type RuntimeInvoker = AgentQueryChatDeps["runtimeInvoker"];

const identityHeaders = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

const expectedUserMessage = {
	id: "user-message-1",
	role: "user",
	parts: [{ type: "text", text: "Tell me something" }],
};

function input(overrides: Record<string, unknown> = {}) {
	return {
		id: "conversation-1",
		messages: [expectedUserMessage],
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

function textMessages(completeText: string, ...deltas: string[]): SDKMessage[] {
	const providerMessageId = crypto.randomUUID();
	return [
		streamEvent({
			type: "message_start",
			message: { id: providerMessageId, content: [] },
		}),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		...deltas.map((text) =>
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			}),
		),
		assistantMessage([{ type: "text", text: completeText }], providerMessageId),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_stop" }),
	];
}

function assistantMessage(
	content: unknown[],
	providerMessageId: string = crypto.randomUUID(),
): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: providerMessageId,
			type: "message",
			role: "assistant",
			content,
			model: "claude-sonnet-5",
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 1 },
		},
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
	} as unknown as SDKMessage;
}

function toolResultMessage(
	toolUseId: string,
	content: unknown,
	isError = false,
): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content,
					...(isError ? { is_error: true } : {}),
				},
			],
		},
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
		...textMessages("A direct answer.", "A direct ", "answer."),
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
	overrides: Partial<
		Pick<AgentQueryChatDeps, "resumableStreams" | "responseRenewIntervalMs">
	> = {},
) {
	const app = new Hono<AppEnv>();
	let messageId = 0;
	app.route(
		"/api/chat",
		createAiChatRoutes({
			messageStore: store,
			runtimeInvoker,
			exposureGate,
			createMessageId: () => `assistant-message-${++messageId}`,
			createStreamId: () => `stream-${messageId + 1}`,
			...overrides,
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
		await tdb.db.delete(conversationRuntime);
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

	it("persists the User before Runtime invocation and the complete Assistant through onEnd", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		const requests: AgentQueryRequest[] = [];
		const runtimeInvoker = {
			async invoke(request: AgentQueryRequest) {
				requests.push(request);
				expect(await listPersistedMessages(tdb)).toEqual([expectedUserMessage]);
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
				conversationEpoch: 8,
				prompt: "Tell me something",
				model: "anthropic/claude-sonnet-5",
			},
		]);
		expect(parseAiSdkSse(await response.text())).toEqual([
			{ type: "start", messageId: "assistant-message-1" },
			{ type: "text-start", id: "assistant-message-1-text-0" },
			{
				type: "text-delta",
				id: "assistant-message-1-text-0",
				delta: "A direct ",
			},
			{
				type: "text-delta",
				id: "assistant-message-1-text-0",
				delta: "answer.",
			},
			{ type: "text-end", id: "assistant-message-1-text-0" },
			{ type: "finish", finishReason: "stop" },
			"[DONE]",
		]);
		expect(await listPersistedMessages(tdb)).toEqual([
			expectedUserMessage,
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

	it("atomically advances epoch/deadline and replaces a stale stream pointer", async () => {
		await tdb.db.update(conversations).set({
			ownerUntil: new Date(Date.now() - 1_000),
			activeStreamId: "stale-stream",
		});
		const app = buildApp(new PostgresChatMessageStore(tdb.db), {
			async invoke(request) {
				const [conversation] = await tdb.db.select().from(conversations);
				expect(request.conversationEpoch).toBe(8);
				expect(conversation).toMatchObject({
					epoch: 8,
					ownerWorkerId: "agent-query",
					activeStreamId: "stream-1",
				});
				expect(conversation?.ownerUntil).toBeInstanceOf(Date);
				expect(await listPersistedMessages(tdb)).toEqual([expectedUserMessage]);
				return successfulClaudeEvents();
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		expect(response.status).toBe(200);
		await response.text();
		const [completed] = await tdb.db.select().from(conversations);
		expect(completed).toMatchObject({
			epoch: 8,
			ownerWorkerId: null,
			ownerUntil: null,
			activeStreamId: null,
		});
	});

	it("rejects a live response deadline before any new-work side effect", async () => {
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: new Date(Date.now() + 60_000) });
		let invocations = 0;
		const app = buildApp(new PostgresChatMessageStore(tdb.db), {
			async invoke() {
				invocations++;
				return successfulClaudeEvents();
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "A response is already active",
		});
		expect(invocations).toBe(0);
		expect(await listPersistedMessages(tdb)).toEqual([]);
		expect((await tdb.db.select().from(conversations))[0]?.epoch).toBe(7);
	});

	it("conditions renewal, stream-pointer cleanup, and completion on the admitted epoch", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		const admission = await store.admitUserMessage(
			{ userId: "member-1", conversationId: "conversation-1" },
			expectedUserMessage as ChatMessage,
			"stream-1",
		);
		if (admission.outcome !== "admitted") throw new Error("admission failed");
		expect(
			await store.clearActiveStreamId(
				{ userId: "member-1", conversationId: "conversation-1" },
				admission.conversationEpoch,
				"wrong-stream",
			),
		).toBe(false);
		expect(
			await store.renewResponseAuthority(
				{ userId: "member-1", conversationId: "conversation-1" },
				admission.conversationEpoch,
			),
		).toBeInstanceOf(Date);
		await tdb.db.update(conversations).set({
			epoch: admission.conversationEpoch + 1,
			ownerUntil: new Date(Date.now() + 60_000),
			activeStreamId: "stream-2",
		});

		expect(
			await store.renewResponseAuthority(
				{ userId: "member-1", conversationId: "conversation-1" },
				admission.conversationEpoch,
			),
		).toBeNull();
		await expect(
			store.persistAssistantMessageAndSession(
				{ userId: "member-1", conversationId: "conversation-1" },
				admission.conversationEpoch,
				{
					id: "assistant-stale",
					role: "assistant",
					parts: [{ type: "text", text: "stale" }],
				},
				"agent-session-stale",
			),
		).rejects.toThrow("response authority");
		expect(await listPersistedMessages(tdb)).toEqual([expectedUserMessage]);
		expect((await tdb.db.select().from(conversations))[0]?.activeStreamId).toBe(
			"stream-2",
		);
	});

	it("aborts Runtime work when matching-epoch renewal is rejected", async () => {
		const postgresStore = new PostgresChatMessageStore(tdb.db);
		let renewals = 0;
		const store = Object.assign(Object.create(postgresStore), {
			async renewResponseAuthority() {
				renewals++;
				return null;
			},
		}) as MessageStore;
		let runtimeAborted = false;
		const app = buildApp(
			store,
			{
				async invoke(_request, signal) {
					return {
						async *[Symbol.asyncIterator]() {
							if (!signal?.aborted) {
								await new Promise<void>((resolve) =>
									signal?.addEventListener("abort", () => resolve(), {
										once: true,
									}),
								);
							}
							runtimeAborted = true;
							throw new Error("Runtime request aborted");
						},
					};
				},
			},
			undefined,
			{ responseRenewIntervalMs: 1 },
		);

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		expect(await response.text()).toContain(
			'"type":"error","errorText":"Response failed"',
		);
		expect(renewals).toBeGreaterThan(0);
		expect(runtimeAborted).toBe(true);
		expect(await listPersistedMessages(tdb)).toEqual([expectedUserMessage]);
	});

	it("serves canonical history and resumes the active AI SDK stream", async () => {
		let resumable: ReadableStream<string> | undefined;
		const app = buildApp(
			new PostgresChatMessageStore(tdb.db),
			{
				async invoke() {
					return successfulClaudeEvents();
				},
			},
			undefined,
			{
				resumableStreams: {
					async create(_streamId, stream) {
						resumable = stream;
					},
					async resume() {
						return resumable;
					},
				},
			},
		);

		expect(
			(
				await app.request("/api/chat/conversation-1/stream", {
					headers: identityHeaders,
				})
			).status,
		).toBe(204);
		const original = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		const resumed = await app.request("/api/chat/conversation-1/stream", {
			headers: identityHeaders,
		});
		expect(resumed.status).toBe(200);
		expect(resumed.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		expect(await resumed.text()).toContain('"delta":"A direct "');
		await original.body?.cancel();

		const history = await app.request("/api/chat/conversation-1", {
			headers: identityHeaders,
		});
		expect(history.status).toBe(200);
		expect(await history.json()).toEqual([
			expectedUserMessage,
			{
				id: "assistant-message-1",
				role: "assistant",
				parts: [{ type: "text", text: "A direct answer.", state: "done" }],
			},
		]);
	});

	it("isolates Redis failures to browser resumption", async () => {
		const app = buildApp(
			new PostgresChatMessageStore(tdb.db),
			{
				async invoke() {
					return successfulClaudeEvents();
				},
			},
			undefined,
			{
				resumableStreams: {
					async create() {
						throw new Error("Redis unavailable");
					},
					async resume() {
						throw new Error("Redis unavailable");
					},
				},
			},
		);
		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"finishReason":"stop"');
		expect(await listPersistedMessages(tdb)).toHaveLength(2);

		await tdb.db
			.update(conversations)
			.set({ activeStreamId: "missing-stream" });
		const resume = await app.request("/api/chat/conversation-1/stream", {
			headers: identityHeaders,
		});
		expect(resume.status).toBe(503);
		expect(await resume.json()).toEqual({
			error: "Response resumption unavailable",
		});
	});

	it("returns 204 and clears a stale pointer when Redis has no stream", async () => {
		await tdb.db.update(conversations).set({ activeStreamId: "stale-stream" });
		const app = buildApp(
			new PostgresChatMessageStore(tdb.db),
			{
				async invoke() {
					return successfulClaudeEvents();
				},
			},
			undefined,
			{
				resumableStreams: {
					async create() {},
					async resume() {
						return undefined;
					},
				},
			},
		);

		const response = await app.request("/api/chat/conversation-1/stream", {
			headers: identityHeaders,
		});
		expect(response.status).toBe(204);
		expect(
			(await tdb.db.select().from(conversations))[0]?.activeStreamId,
		).toBeNull();
		expect(await listPersistedMessages(tdb)).toEqual([]);
	});

	it("streams and persists completed Tool invocations and results in the Assistant UIMessage", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		const app = buildApp(store, {
			async invoke() {
				return [
					...textMessages("I will write the file.", "I will write the file."),
					streamEvent({
						type: "message_start",
						message: { id: "provider-tool-message", content: [] },
					}),
					streamEvent({
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "tool-use-1",
							name: "mcp__mymemo-executor__Write",
							input: {},
						},
					}),
					streamEvent({
						type: "content_block_delta",
						index: 0,
						delta: {
							type: "input_json_delta",
							partial_json: '{"path":"notes.md","content":"hello"}',
						},
					}),
					assistantMessage(
						[
							{
								type: "tool_use",
								id: "tool-use-1",
								name: "mcp__mymemo-executor__Write",
								input: { path: "notes.md", content: "hello" },
							},
						],
						"provider-tool-message",
					),
					streamEvent({ type: "content_block_stop", index: 0 }),
					streamEvent({ type: "message_stop" }),
					toolResultMessage("tool-use-1", [
						{
							type: "text",
							text: '{"path":"notes.md","bytesWritten":5}',
						},
					]),
					...textMessages("Done.", "Done."),
					resultEvent(),
				];
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		const responseText = await response.text();

		expect(responseText).toContain('"type":"tool-input-available"');
		expect(responseText).toContain('"type":"tool-output-available"');
		expect(responseText).not.toContain("tool-use-1");
		expect(await listPersistedMessages(tdb)).toEqual([
			expectedUserMessage,
			{
				id: "assistant-message-1",
				role: "assistant",
				parts: [
					{ type: "text", text: "I will write the file.", state: "done" },
					{
						type: "dynamic-tool",
						toolName: "Write",
						toolCallId: expect.stringMatching(
							/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
						),
						state: "output-available",
						input: {
							path: "notes.md",
							content: "hello",
							contentBytes: 5,
						},
						output: { path: "notes.md", bytesWritten: 5 },
					},
					{ type: "text", text: "Done.", state: "done" },
				],
			},
		]);
	});

	it("redacts an errored Tool result in the Assistant UIMessage", async () => {
		const app = buildApp(new PostgresChatMessageStore(tdb.db), {
			async invoke() {
				return [
					assistantMessage([
						{
							type: "tool_use",
							id: "tool-use-1",
							name: "mcp__mymemo-executor__Write",
							input: { path: "notes.md", content: "hello" },
						},
					]),
					toolResultMessage("tool-use-1", "private failure", true),
					resultEvent(),
				];
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		const responseText = await response.text();

		expect(responseText).toContain('"type":"tool-output-error"');
		expect(responseText).not.toContain("private failure");
		expect(responseText).not.toContain("tool-use-1");
		expect((await listPersistedMessages(tdb))[1]?.parts).toEqual([
			{
				type: "dynamic-tool",
				toolName: "Write",
				toolCallId: expect.stringMatching(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				),
				state: "output-error",
				input: {
					path: "notes.md",
					content: "hello",
					contentBytes: 5,
				},
				errorText: "Tool failed",
			},
		]);
	});

	it("continues the stored opaque Agent session across sequential responses", async () => {
		const requests: AgentQueryRequest[] = [];
		const app = buildApp(new PostgresChatMessageStore(tdb.db), {
			async invoke(request) {
				requests.push(request);
				return successfulClaudeEvents().map((event) =>
					event.type === "result"
						? resultEvent({ session_id: `agent-session-${requests.length}` })
						: event,
				);
			},
		});

		const first = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		await first.text();
		const second = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(
				input({
					messages: [
						{
							id: "user-message-2",
							role: "user",
							parts: [{ type: "text", text: "Continue" }],
						},
					],
				}),
			),
		});
		await second.text();

		expect(requests[0]).not.toHaveProperty("agentSessionId");
		expect(requests[1]).toMatchObject({
			prompt: "Continue",
			agentSessionId: "agent-session-1",
		});
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBe("agent-session-2");
	});

	it("does not reconstruct Agent context from public UIMessage history", async () => {
		await tdb.db.insert(conversationMessages).values([
			{
				userId: "member-1",
				conversationId: "conversation-1",
				messageId: "old-user",
				role: "user",
				parts: [{ type: "text", text: "private old prompt" }],
			},
			{
				userId: "member-1",
				conversationId: "conversation-1",
				messageId: "old-assistant",
				role: "assistant",
				parts: [{ type: "text", text: "private old answer", state: "done" }],
			},
		]);
		let runtimeRequest: AgentQueryRequest | undefined;
		const app = buildApp(new PostgresChatMessageStore(tdb.db), {
			async invoke(request) {
				runtimeRequest = request;
				return successfulClaudeEvents();
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});
		await response.text();

		expect(runtimeRequest).toMatchObject({ prompt: "Tell me something" });
		expect(runtimeRequest).not.toHaveProperty("messages");
		expect(runtimeRequest).not.toHaveProperty("agentSessionId");
	});

	it("does not persist a partial Assistant when the client aborts", async () => {
		const store = new PostgresChatMessageStore(tdb.db);
		const runtimeGate = Promise.withResolvers<void>();
		const runtimeFinished = Promise.withResolvers<void>();
		const app = buildApp(store, {
			async invoke() {
				return {
					async *[Symbol.asyncIterator]() {
						const events = successfulClaudeEvents();
						try {
							for (const event of events.slice(0, 4)) yield event;
							await runtimeGate.promise;
							for (const event of events.slice(4)) yield event;
						} finally {
							runtimeFinished.resolve();
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
		runtimeGate.resolve();
		await runtimeFinished.promise;
		expect(await listPersistedMessages(tdb)).toEqual([expectedUserMessage]);
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
			expect(await listPersistedMessages(tdb)).toEqual([expectedUserMessage]);
		});
	}

	it("leaves only the User when onEnd persistence fails", async () => {
		const postgresStore = new PostgresChatMessageStore(tdb.db);
		const store = Object.assign(Object.create(postgresStore), {
			async persistAssistantMessageAndSession() {
				throw new Error("private database and session persistence failure");
			},
		}) as MessageStore;
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

		await expect(response.text()).rejects.toThrow();
		expect(await listPersistedMessages(tdb)).toEqual([expectedUserMessage]);
	});

	it("rolls back the Agent-session mapping when Assistant persistence fails", async () => {
		await tdb.db.insert(conversationRuntime).values({
			userId: "member-1",
			conversationId: "conversation-1",
			agentSessionId: "agent-session-existing",
		});
		const postgresStore = new PostgresChatMessageStore(tdb.db);
		const store = Object.assign(Object.create(postgresStore), {
			async persistAssistantMessageAndSession(
				ref: Parameters<
					PostgresChatMessageStore["persistAssistantMessageAndSession"]
				>[0],
				conversationEpoch: number,
				message: Parameters<
					PostgresChatMessageStore["persistAssistantMessageAndSession"]
				>[2],
				agentSessionId: string,
			) {
				await postgresStore.persistAssistantMessageAndSession(
					ref,
					conversationEpoch,
					{ ...message, id: "user-message-1" },
					agentSessionId,
				);
			},
		}) as MessageStore;
		let invocations = 0;
		const app = buildApp(store, {
			async invoke() {
				invocations++;
				return successfulClaudeEvents().map((event) =>
					event.type === "result"
						? resultEvent({ session_id: "agent-session-uncommitted" })
						: event,
				);
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(input()),
		});

		await expect(response.text()).rejects.toThrow();
		expect(invocations).toBe(1);
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBe("agent-session-existing");
	});
});
