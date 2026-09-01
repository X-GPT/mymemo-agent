import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { conversationMessages, conversations } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { PostgresConversationMessagesStore } from "./postgres-conversation-messages-store";

let tdb: TestDb;
let store: PostgresConversationMessagesStore;

beforeAll(async () => {
	tdb = await createTestDatabase();
	store = new PostgresConversationMessagesStore(tdb.db);
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
	});
});

function userRow(
	sequence: number,
	messageId: string,
	turn: Partial<{
		status: string;
		startedAt: Date;
		finishedAt: Date;
	}> = {},
) {
	return {
		sequence,
		userId: "member-1",
		conversationId: "conversation-1",
		messageId,
		role: "user",
		parts: [{ type: "text", text: messageId }],
		status: turn.status ?? "done",
		startedAt: turn.startedAt ?? null,
		finishedAt: turn.finishedAt ?? null,
	};
}

function assistantRow(sequence: number, messageId: string, parts: unknown) {
	return {
		sequence,
		userId: "member-1",
		conversationId: "conversation-1",
		messageId,
		role: "assistant",
		parts,
	};
}

function getPage(input: Partial<Parameters<typeof store.getPage>[0]> = {}) {
	return store.getPage({
		userId: "member-1",
		conversationId: "conversation-1",
		limit: 50,
		before: null,
		...input,
	});
}

describe("PostgresConversationMessagesStore", () => {
	it("serves Turns ascending: user rows carry Turn metadata, assistant parts return verbatim", async () => {
		const startedAt = new Date("2026-08-31T01:00:00.000Z");
		const finishedAt = new Date("2026-08-31T01:00:09.000Z");
		const assistantParts = [
			{ type: "step-start" },
			{
				type: "tool-Bash",
				toolCallId: "call-1",
				state: "output-available",
				input: { command: "ls" },
				output: "notes.md",
			},
			{ type: "text", text: "Listed your files." },
		];
		await tdb.db
			.insert(conversationMessages)
			.values([
				userRow(1, "user-1", { status: "done", startedAt, finishedAt }),
				assistantRow(2, "assistant-1", assistantParts),
				userRow(3, "user-2", { status: "interrupted", startedAt }),
			]);

		const page = await getPage();

		expect(page).toEqual({
			messages: [
				{
					id: "user-1",
					role: "user",
					parts: [{ type: "text", text: "user-1" }],
					metadata: { status: "done", startedAt, finishedAt },
				},
				{ id: "assistant-1", role: "assistant", parts: assistantParts },
				{
					id: "user-2",
					role: "user",
					parts: [{ type: "text", text: "user-2" }],
					metadata: { status: "interrupted", startedAt, finishedAt: null },
				},
			],
			nextCursor: null,
		});
		// toEqual treats an undefined value as a missing key, so absence needs
		// its own assertion: assistant messages must not serialize a metadata key.
		expect(Object.keys(page?.messages[1] ?? {})).not.toContain("metadata");
	});

	it("pages backwards on a before cursor that later appends cannot destabilize", async () => {
		await tdb.db
			.insert(conversationMessages)
			.values([1, 2, 3, 4, 5].map((n) => userRow(n, `user-${n}`)));

		const newest = await getPage({ limit: 2 });
		expect(newest?.messages.map((m) => m.id)).toEqual(["user-4", "user-5"]);
		expect(newest?.nextCursor).toBe(4);

		// The append lands after the cursor was handed out; older pages must not
		// shift under the client mid-walk.
		await tdb.db.insert(conversationMessages).values(userRow(6, "user-6"));

		const older = await getPage({ limit: 2, before: 4 });
		expect(older?.messages.map((m) => m.id)).toEqual(["user-2", "user-3"]);
		expect(older?.nextCursor).toBe(2);

		const oldest = await getPage({ limit: 2, before: 2 });
		expect(oldest?.messages.map((m) => m.id)).toEqual(["user-1"]);
		expect(oldest?.nextCursor).toBeNull();
	});

	it("returns an empty page — not null — for a Conversation with no v2 rows (the pre-v2 case)", async () => {
		expect(await getPage()).toEqual({ messages: [], nextCursor: null });
	});

	it("returns null for a missing or foreign Conversation", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-2",
			conversationId: "conversation-2",
			scope: "general",
		});
		await tdb.db.insert(conversationMessages).values({
			...userRow(10, "foreign-1"),
			userId: "member-2",
			conversationId: "conversation-2",
		});

		expect(await getPage({ conversationId: "missing" })).toBeNull();
		expect(await getPage({ conversationId: "conversation-2" })).toBeNull();
	});

	it("reads an archived Conversation normally", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-archived",
			scope: "general",
			archivedAt: new Date("2026-08-30T00:00:00.000Z"),
		});
		await tdb.db.insert(conversationMessages).values({
			...userRow(20, "archived-1"),
			conversationId: "conversation-archived",
		});

		const page = await getPage({ conversationId: "conversation-archived" });
		expect(page?.messages.map((m) => m.id)).toEqual(["archived-1"]);
	});

	it("rejects a non-positive limit before querying", async () => {
		await expect(getPage({ limit: 0 })).rejects.toThrow(
			"Messages page limit must be a positive integer",
		);
	});
});

describe("PostgresConversationMessagesStore Turn submission", () => {
	const ref = {
		userId: "member-1",
		conversationId: "conversation-1",
		messageId: "turn-1",
	};
	const parts = [{ type: "text", text: "hi" }];

	it("queues a new Turn once; a re-POST is a duplicate that changes nothing", async () => {
		expect(await store.enqueueTurn({ ...ref, parts })).toEqual({
			outcome: "queued",
		});
		expect(await store.getTurnStatus(ref)).toBe("queued");

		expect(
			await store.enqueueTurn({
				...ref,
				parts: [{ type: "text", text: "changed" }],
			}),
		).toEqual({ outcome: "duplicate", status: "queued" });
		const page = await getPage();
		expect(page?.messages).toEqual([
			{
				id: "turn-1",
				role: "user",
				parts,
				metadata: { status: "queued", startedAt: null, finishedAt: null },
			},
		]);

		await tdb.db
			.update(conversationMessages)
			.set({ status: "done", finishedAt: new Date() });
		expect(await store.enqueueTurn({ ...ref, parts })).toEqual({
			outcome: "duplicate",
			status: "done",
		});
	});

	it("refuses an archived Conversation without writing", async () => {
		await tdb.db
			.update(conversations)
			.set({ archivedAt: new Date("2026-08-30T00:00:00.000Z") });
		expect(await store.enqueueTurn({ ...ref, parts })).toEqual({
			outcome: "archived",
		});
		expect(await store.getTurnStatus(ref)).toBeNull();
	});

	it("reports missing and foreign Conversations identically", async () => {
		expect(
			await store.enqueueTurn({ ...ref, conversationId: "nope", parts }),
		).toEqual({ outcome: "not_found" });
		expect(
			await store.enqueueTurn({ ...ref, userId: "member-2", parts }),
		).toEqual({ outcome: "not_found" });
	});
});
