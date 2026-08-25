import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase, type Database } from "@mymemo/agent-db/client";
import { conversationOwnershipLeaseDeadline } from "@mymemo/agent-db/conversation-ownership";
import { publishAgentQueryWorkspaceTx } from "@mymemo/agent-db/runtime-store";
import {
	agentSessions,
	conversationMessages,
	conversationRuntime,
	conversations,
} from "@mymemo/agent-db/schema";
import { appendAgentQuerySessionEntriesTx } from "@mymemo/agent-db/session-store";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "@/deps";
import { PostgresConversationStore } from "@/features/conversation-store/postgres-conversation-store";
import { createAiChatRoutes } from "./ai-chat.route";
import {
	type ChatMessage,
	PostgresChatMessageStore,
} from "./postgres-chat-message-store";

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = process.env.RUN_AGENT_QUERY_POSTGRES_TESTS === "true";
const USER_ID = `agent-query-authority-${crypto.randomUUID()}`;
const CONVERSATION_ID = `${USER_ID}-conversation`;
const ref = { userId: USER_ID, conversationId: CONVERSATION_ID };

if (RUN) setDefaultTimeout(30_000);

let db: Database;
let messages: PostgresChatMessageStore;
let conversationStore: PostgresConversationStore;

function userMessage(id: string): ChatMessage {
	return { id, role: "user", parts: [{ type: "text", text: id }] };
}

function buildApp(responseGate: Promise<void>) {
	const app = new Hono<AppEnv>();
	let id = 0;
	app.route(
		"/api/chat",
		createAiChatRoutes({
			messageStore: messages,
			runtimeInvoker: {
				async invoke() {
					return (async function* (): AsyncGenerator<SDKMessage> {
						await responseGate;
						yield { type: "result" } as SDKMessage;
					})();
				},
			},
			exposureGate: {
				async isAgentEnabled() {
					return true;
				},
			},
			createMessageId: () => `assistant-${++id}`,
			createStreamId: () => `stream-${++id}`,
		}),
	);
	return app;
}

function post(app: Hono<AppEnv>, messageId: string) {
	return app.request("/api/chat", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-member-code": USER_ID,
			"x-partner-code": "partner",
		},
		body: JSON.stringify({
			id: CONVERSATION_ID,
			messages: [userMessage(messageId)],
			model: "anthropic/claude-sonnet-5",
			trigger: "submit-message",
		}),
	});
}

async function releaseResponses(
	gate: PromiseWithResolvers<void>,
	responses: Response[],
) {
	gate.resolve();
	await Promise.all(
		responses
			.filter(({ status }) => status === 200)
			.map((response) => response.text()),
	);
}

async function cleanup() {
	await db
		.delete(agentSessions)
		.where(eq(agentSessions.conversationId, CONVERSATION_ID));
	await db
		.delete(conversationRuntime)
		.where(eq(conversationRuntime.userId, USER_ID));
	await db.delete(conversations).where(eq(conversations.userId, USER_ID));
}

async function seed() {
	await db.insert(conversations).values({
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		scope: "general",
	});
}

describe.skipIf(!RUN)(
	"Agent-query response authority against real Postgres",
	() => {
		beforeAll(() => {
			db = createDatabase(DB_URL);
			messages = new PostgresChatMessageStore(db);
			conversationStore = new PostgresConversationStore(db);
		});

		beforeEach(async () => {
			await cleanup();
			await seed();
		});

		afterAll(async () => {
			await cleanup();
			await db.$client.end();
		});

		it("serializes mounted POST-vs-POST admission", async () => {
			const gate = Promise.withResolvers<void>();
			const app = buildApp(gate.promise);
			const responses = await Promise.all([
				post(app, "user-a"),
				post(app, "user-b"),
			]);

			expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
			expect(
				await db
					.select({ id: conversationMessages.messageId })
					.from(conversationMessages)
					.where(eq(conversationMessages.userId, USER_ID)),
			).toHaveLength(1);
			expect(
				(
					await db
						.select()
						.from(conversations)
						.where(
							and(
								eq(conversations.userId, USER_ID),
								eq(conversations.conversationId, CONVERSATION_ID),
							),
						)
				)[0]?.epoch,
			).toBe(1);
			await releaseResponses(gate, responses);
		});

		it("serializes mounted POST-vs-Archive while allowing rename", async () => {
			const gate = Promise.withResolvers<void>();
			const app = buildApp(gate.promise);
			const [response, archived] = await Promise.all([
				post(app, "user-a"),
				conversationStore.update(ref, { archived: true }),
			]);
			if (response.status === 200) {
				expect(archived).toEqual({ outcome: "active_work" });
			} else {
				expect(response.status).toBe(409);
				expect(archived).toMatchObject({ outcome: "updated" });
			}
			await expect(
				conversationStore.update(ref, { title: "Renamed" }),
			).resolves.toMatchObject({ outcome: "updated" });
			await releaseResponses(gate, [response]);
		});

		it("serializes mounted POST-vs-Permanent deletion", async () => {
			const gate = Promise.withResolvers<void>();
			const app = buildApp(gate.promise);
			const [response, deleted] = await Promise.all([
				post(app, "user-a"),
				conversationStore.deletePermanently(ref),
			]);
			if (response.status === 200) {
				expect(deleted).toEqual({ outcome: "active_work" });
			} else {
				expect(response.status).toBe(404);
				expect(deleted).toEqual({ outcome: "deleted" });
			}
			await releaseResponses(gate, [response]);
		});

		it("does not let renewal revive a superseded epoch", async () => {
			const admission = await messages.admitUserMessage(
				ref,
				userMessage("user-a"),
			);
			if (admission.outcome !== "admitted") throw new Error("admission failed");

			await Promise.all([
				messages.renewResponseAuthority(ref, admission.conversationEpoch),
				db
					.update(conversations)
					.set({
						epoch: sql`${conversations.epoch} + 1`,
						ownerUntil: conversationOwnershipLeaseDeadline(),
					})
					.where(eq(conversations.userId, USER_ID)),
			]);
			expect(
				await messages.renewResponseAuthority(ref, admission.conversationEpoch),
			).toBeNull();
		});

		it("commits only matching-epoch completion", async () => {
			const admission = await messages.admitUserMessage(
				ref,
				userMessage("user-a"),
			);
			if (admission.outcome !== "admitted") throw new Error("admission failed");
			await messages.persistAssistantMessageAndSession(
				ref,
				admission.conversationEpoch,
				{
					id: "assistant-a",
					role: "assistant",
					parts: [{ type: "text", text: "done" }],
				},
				"agent-session-a",
			);
			expect(
				await db
					.select({ role: conversationMessages.role })
					.from(conversationMessages)
					.where(eq(conversationMessages.userId, USER_ID)),
			).toHaveLength(2);
			expect(
				(
					await db
						.select()
						.from(conversations)
						.where(
							and(
								eq(conversations.userId, USER_ID),
								eq(conversations.conversationId, CONVERSATION_ID),
							),
						)
				)[0],
			).toMatchObject({ ownerUntil: null, activeStreamId: null });
		});

		it("rejects stale SessionStore and Workspace mutations", async () => {
			const admission = await messages.admitUserMessage(
				ref,
				userMessage("user-a"),
			);
			if (admission.outcome !== "admitted") throw new Error("admission failed");
			await db
				.update(conversations)
				.set({
					epoch: admission.conversationEpoch + 1,
					ownerUntil: conversationOwnershipLeaseDeadline(),
				})
				.where(eq(conversations.userId, USER_ID));

			await expect(
				appendAgentQuerySessionEntriesTx(db, {
					conversationId: CONVERSATION_ID,
					conversationEpoch: admission.conversationEpoch,
					ref: { projectKey: "project", sessionId: "session" },
					entries: [{ uuid: "entry" }],
				}),
			).rejects.toThrow("response authority");
			await expect(
				publishAgentQueryWorkspaceTx(db, {
					...ref,
					conversationEpoch: admission.conversationEpoch,
					sandboxId: "sandbox-stale",
				}),
			).rejects.toThrow("response authority");
		});
	},
);
