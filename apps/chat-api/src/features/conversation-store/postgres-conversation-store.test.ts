import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { conversations } from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import type { ConversationRecord } from "./conversation-store";
import { PostgresConversationStore } from "./postgres-conversation-store";

const collectionConversation: ConversationRecord = {
	userId: "user-1",
	conversationId: "conv-1",
	scope: "collection",
	collectionId: "col-1",
	summaryId: null,
};

describe("PostgresConversationStore", () => {
	let tdb: TestDb;
	let store: PostgresConversationStore;

	// One PGlite instance for the whole file (spin-up is the slow part); each test
	// starts from an empty conversations table via delete, keeping isolation
	// without the cost.
	beforeAll(async () => {
		tdb = await createTestDatabase();
		store = new PostgresConversationStore(tdb.db);
	});

	afterAll(() => tdb.close());

	afterEach(async () => {
		await tdb.db.delete(conversations);
	});

	it("get returns null when the conversation does not exist", async () => {
		expect(
			await store.get({ userId: "nobody", conversationId: "none" }),
		).toBeNull();
	});

	it("create then get round-trips the frozen scope", async () => {
		await store.create(collectionConversation);
		expect(
			await store.get({ userId: "user-1", conversationId: "conv-1" }),
		).toEqual(collectionConversation);
	});

	it("round-trips general and document scopes with null id columns", async () => {
		await store.create({
			userId: "u",
			conversationId: "general",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
		await store.create({
			userId: "u",
			conversationId: "doc",
			scope: "document",
			collectionId: null,
			summaryId: "sum-9",
		});

		expect(
			(await store.get({ userId: "u", conversationId: "general" }))?.scope,
		).toBe("general");
		const doc = await store.get({ userId: "u", conversationId: "doc" });
		expect(doc?.scope).toBe("document");
		expect(doc?.summaryId).toBe("sum-9");
	});

	it("rejects a second create for the same conversation (no silent re-scope)", async () => {
		await store.create(collectionConversation);
		await expect(
			store.create({
				...collectionConversation,
				scope: "general",
				collectionId: null,
			}),
		).rejects.toThrow();

		// The original scope is unchanged.
		expect(
			(await store.get({ userId: "user-1", conversationId: "conv-1" }))?.scope,
		).toBe("collection");
	});

	it("isolates conversations by owner", async () => {
		await store.create(collectionConversation);
		expect(
			await store.get({ userId: "other", conversationId: "conv-1" }),
		).toBeNull();
	});
});
