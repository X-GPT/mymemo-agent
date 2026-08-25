import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
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
import { PostgresConversationStore } from "@/features/conversation-store/postgres-conversation-store";
import {
	type ChatMessage,
	PostgresChatMessageStore,
} from "./postgres-chat-message-store";

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = DB_URL !== "";
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

		it("serializes concurrent admissions to one User message and one epoch", async () => {
			const admissions = await Promise.all([
				messages.admitUserMessage(ref, userMessage("user-a"), "stream-a"),
				messages.admitUserMessage(ref, userMessage("user-b"), "stream-b"),
			]);

			expect(admissions.map(({ outcome }) => outcome).sort()).toEqual([
				"admitted",
				"conflict",
			]);
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
		});

		it("rejects Archive and Permanent deletion while allowing rename", async () => {
			await messages.admitUserMessage(ref, userMessage("user-a"), "stream-a");

			await expect(
				conversationStore.update(ref, { title: "Renamed" }),
			).resolves.toMatchObject({ outcome: "updated" });
			const [archived, deleted] = await Promise.all([
				conversationStore.update(ref, { archived: true }),
				conversationStore.deletePermanently(ref),
			]);
			expect(archived).toEqual({ outcome: "active_run" });
			expect(deleted).toEqual({ outcome: "active_run" });
		});

		it("does not let renewal revive a superseded epoch", async () => {
			const admission = await messages.admitUserMessage(
				ref,
				userMessage("user-a"),
				"stream-a",
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
				"stream-a",
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
				"stream-a",
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
