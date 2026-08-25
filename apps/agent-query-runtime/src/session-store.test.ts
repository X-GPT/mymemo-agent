import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { agentSessions, conversations } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { createDirectResponseSessionStore } from "./session-store";

describe("direct-response Postgres SessionStore", () => {
	let tdb: TestDb;

	beforeAll(async () => {
		tdb = await createTestDatabase();
	});

	afterAll(async () => {
		await tdb.close();
	});

	beforeEach(async () => {
		await tdb.db.delete(agentSessions);
		await tdb.db.delete(conversations);
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			epoch: 7,
		});
	});

	it("round-trips the opaque transcript and records main-session mirror evidence", async () => {
		const store = createDirectResponseSessionStore(tdb.db, {
			conversationId: "conversation-1",
			conversationEpoch: 7,
		});
		const key = {
			projectKey: "-workspace-conversations-conversation-1",
			sessionId: "agent-session-1",
		};
		const entries = [
			{ type: "user", uuid: "entry-1", message: { content: "opaque" } },
		] as SessionStoreEntry[];

		await store.append(key, entries);

		expect(await store.load(key)).toEqual(entries);
		expect(store.mirroredMainSessionId()).toBe("agent-session-1");
		expect((await tdb.db.select().from(agentSessions))[0]).toMatchObject({
			conversationId: "conversation-1",
			epoch: 7,
			projectKey: key.projectKey,
			sessionId: "agent-session-1",
		});
	});

	it("rejects transcript persistence after the Conversation epoch changes", async () => {
		const store = createDirectResponseSessionStore(tdb.db, {
			conversationId: "conversation-1",
			conversationEpoch: 7,
		});
		await tdb.db.update(conversations).set({ epoch: 8 });

		await expect(
			store.append(
				{ projectKey: "project", sessionId: "agent-session-stale" },
				[{ type: "user", uuid: "entry-stale" } as SessionStoreEntry],
			),
		).rejects.toThrow("stale Conversation epoch");
		expect(await tdb.db.select().from(agentSessions)).toEqual([]);
		expect(store.mirroredMainSessionId()).toBeNull();
	});
});
