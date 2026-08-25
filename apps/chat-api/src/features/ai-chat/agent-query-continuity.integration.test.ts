import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type {
	Options,
	SDKMessage,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import {
	agentSessions,
	conversationMessages,
	conversationRuntime,
	conversations,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import { asc } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "@/deps";
import {
	AGENTCORE_RUNTIME_SESSION_HEADER,
	createAgentQueryRequestHandler,
} from "../../../../agent-query-runtime/src/server";
import { createAgentQuerySessionStore } from "../../../../agent-query-runtime/src/session-store";
import { createAgentQueryWorkspacePreparer } from "../../../../agent-query-runtime/src/workspace";
import type {
	ProvisionedSandbox,
	ProvisionForRunInput,
} from "../../../../agentcore-runtime/src/e2b/sandbox-provisioner";
import { createAiChatRoutes } from "./ai-chat.route";
import { PostgresChatMessageStore } from "./postgres-chat-message-store";

const headers = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

function body(messageId: string, prompt: string) {
	return JSON.stringify({
		id: "conversation-1",
		messages: [
			{ id: messageId, role: "user", parts: [{ type: "text", text: prompt }] },
		],
		model: "anthropic/claude-sonnet-5",
		trigger: "submit-message",
	});
}

function claudeMessages(sessionId: string): SDKMessage[] {
	const providerMessageId = crypto.randomUUID();
	const stream = (event: Record<string, unknown>) =>
		({
			type: "stream_event",
			event,
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: sessionId,
		}) as unknown as SDKMessage;
	return [
		stream({
			type: "message_start",
			message: { id: providerMessageId, content: [] },
		}),
		stream({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		stream({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "continued" },
		}),
		{
			type: "assistant",
			message: {
				id: providerMessageId,
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "continued" }],
				model: "claude-sonnet-5",
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: sessionId,
		} as unknown as SDKMessage,
		stream({ type: "content_block_stop", index: 0 }),
		stream({ type: "message_stop" }),
		{
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "provider echo",
			stop_reason: "end_turn",
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: crypto.randomUUID(),
			session_id: sessionId,
		} as unknown as SDKMessage,
	];
}

describe("non-production Agent-query continuity", () => {
	let tdb: TestDb;

	beforeAll(async () => {
		tdb = await createTestDatabase();
	});

	afterAll(async () => {
		await tdb.close();
	});

	it("continues one Agent session and Workspace across two Chat API responses", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			epoch: 7,
		});
		const provisions: ProvisionForRunInput[] = [];
		const prepareWorkspace = createAgentQueryWorkspacePreparer({
			db: tdb.db,
			sandboxIdleMs: 300_000,
			logger: { info() {}, warn() {} },
			provisioner: {
				async provisionForRun(input) {
					provisions.push(input);
					return {
						sandboxId: input.sandboxId ?? "sandbox-1",
						isNew: input.sandboxId === null,
						workspaceRoot: "/home/user",
						fileClient: {},
						commandClient: {},
						artifactWorkspace: {},
						async renew() {},
						dispose() {},
					} as ProvisionedSandbox;
				},
			},
		});
		const resumes: Array<string | undefined> = [];
		let queryCount = 0;
		const runtimeHandler = createAgentQueryRequestHandler({
			createSessionStore: (owner) =>
				createAgentQuerySessionStore(tdb.db, owner),
			async prepareWorkingDirectory() {},
			prepareWorkspace,
			async verifyResponseAuthority() {},
			query({ options }: { options: Options }) {
				resumes.push(options.resume);
				const sessionId = `agent-session-${++queryCount}`;
				return (async function* () {
					await options.sessionStore?.append(
						{
							projectKey: "-workspace-conversations-conversation-1",
							sessionId,
						},
						[
							{
								type: "user",
								uuid: `entry-${queryCount}`,
							} as SessionStoreEntry,
						],
					);
					yield* claudeMessages(sessionId);
				})();
			},
		});
		const app = new Hono<AppEnv>();
		let assistantId = 0;
		app.route(
			"/api/chat",
			createAiChatRoutes({
				messageStore: new PostgresChatMessageStore(tdb.db),
				exposureGate: {
					async isAgentEnabled() {
						return true;
					},
				},
				createMessageId: () => `assistant-${++assistantId}`,
				runtimeInvoker: {
					async invoke(input: AgentQueryRequest) {
						const response = await runtimeHandler(
							new Request("http://runtime/invocations", {
								method: "POST",
								headers: {
									"content-type": "application/json",
									[AGENTCORE_RUNTIME_SESSION_HEADER]: input.conversationId,
								},
								body: JSON.stringify(input),
							}),
						);
						if (!response.ok) throw new Error("Runtime invocation failed");
						return (await response.text())
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line) as SDKMessage);
					},
				},
			}),
		);

		for (const [messageId, prompt] of [
			["user-1", "Start"],
			["user-2", "Continue"],
		] as const) {
			const response = await app.request("/api/chat", {
				method: "POST",
				headers,
				body: body(messageId, prompt),
			});
			expect(response.status).toBe(200);
			await response.text();
		}

		expect(resumes).toEqual([undefined, "agent-session-1"]);
		expect(provisions.map((input) => input.sandboxId)).toEqual([
			null,
			"sandbox-1",
		]);
		expect(await tdb.db.select().from(agentSessions)).toHaveLength(2);
		expect((await tdb.db.select().from(conversationRuntime))[0]).toMatchObject({
			sandboxId: "sandbox-1",
			agentSessionId: "agent-session-2",
		});
		expect(
			await tdb.db
				.select({ role: conversationMessages.role })
				.from(conversationMessages)
				.orderBy(asc(conversationMessages.sequence)),
		).toEqual([
			{ role: "user" },
			{ role: "assistant" },
			{ role: "user" },
			{ role: "assistant" },
		]);
	});
});
