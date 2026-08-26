import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import { asc } from "drizzle-orm";
import {
	admitConversationMessageTx,
	appendAssistantMessageTx,
} from "./conversation-message-store";
import { conversationMessages, conversations } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(conversationMessages);
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conversation-1",
		scope: "general",
	});
});

const start = {
	userId: "user-1",
	conversationId: "conversation-1",
	messageId: "response-1",
	parts: [{ type: "text", text: "hello" }],
} satisfies Parameters<typeof admitConversationMessageTx>[1];

it("admits a User message once and appends its Assistant reply", async () => {
	expect(await admitConversationMessageTx(tdb.db, start)).toEqual({
		outcome: "admitted",
	});
	expect(await admitConversationMessageTx(tdb.db, start)).toEqual({
		outcome: "conflict",
	});
	await appendAssistantMessageTx(tdb.db, {
		userId: start.userId,
		conversationId: start.conversationId,
		messageId: "assistant-1",
		parts: [{ type: "text", text: "answer" }],
	});

	expect(
		await tdb.db
			.select({ role: conversationMessages.role })
			.from(conversationMessages)
			.orderBy(asc(conversationMessages.sequence)),
	).toEqual([{ role: "user" }, { role: "assistant" }]);
});
