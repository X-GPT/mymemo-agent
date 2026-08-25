import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	agentSessions,
	artifactObjects,
	conversationArtifacts,
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type { ConversationCreateInput } from "./conversation-store";
import { PostgresConversationStore } from "./postgres-conversation-store";

const collectionConversation: ConversationCreateInput = {
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
		await tdb.db.delete(agentSessions);
		await tdb.db.delete(artifactObjects);
		await tdb.db.delete(conversationRuntime);
		await tdb.db.delete(conversations);
	});

	it("get returns null when the conversation does not exist", async () => {
		expect(
			await store.get({ userId: "nobody", conversationId: "none" }),
		).toBeNull();
	});

	it("create then get returns frozen scope and lifecycle defaults", async () => {
		await store.create(collectionConversation);
		const persisted = await store.get({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(persisted).toMatchObject({
			...collectionConversation,
			title: null,
			archivedAt: null,
		});
		expect(persisted?.createdAt).toBeInstanceOf(Date);
		expect(persisted?.lastActivityAt).toEqual(persisted?.createdAt);
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

	it("renames and Archives without changing Conversation activity", async () => {
		await store.create(collectionConversation);
		const before = await store.get({
			userId: "user-1",
			conversationId: "conv-1",
		});
		if (!before) throw new Error("conversation was not created");

		const archived = await store.update(
			{ userId: "user-1", conversationId: "conv-1" },
			{ title: "Quarterly plan", archived: true },
		);
		expect(archived).toMatchObject({
			outcome: "updated",
			conversation: {
				title: "Quarterly plan",
			},
		});
		if (archived.outcome !== "updated") throw new Error("update failed");
		expect(archived.conversation.archivedAt).toBeInstanceOf(Date);
		expect(archived.conversation.lastActivityAt).toEqual(before.lastActivityAt);

		const unarchived = await store.update(
			{ userId: "user-1", conversationId: "conv-1" },
			{ archived: false },
		);
		expect(unarchived).toMatchObject({
			outcome: "updated",
			conversation: {
				title: "Quarterly plan",
				archivedAt: null,
				lastActivityAt: before.lastActivityAt,
			},
		});
	});

	it("allows rename but rejects Archive and Permanent deletion while a Run is active", async () => {
		await store.create(collectionConversation);
		await tdb.db.insert(runs).values({
			runId: "run-active",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
		});

		await expect(
			store.update(
				{ userId: "user-1", conversationId: "conv-1" },
				{ title: "Renamed while active" },
			),
		).resolves.toMatchObject({ outcome: "updated" });
		await expect(
			store.update(
				{ userId: "user-1", conversationId: "conv-1" },
				{ archived: true },
			),
		).resolves.toEqual({ outcome: "active_run" });
		await expect(
			store.deletePermanently({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).resolves.toEqual({ outcome: "active_run" });
	});

	it("allows rename but rejects Archive and Permanent deletion before the response deadline", async () => {
		await store.create(collectionConversation);
		await tdb.db.update(conversations).set({
			epoch: 1,
			ownerWorkerId: "agent-query",
			ownerUntil: new Date(Date.now() + 60_000),
		});

		await expect(
			store.update(
				{ userId: "user-1", conversationId: "conv-1" },
				{ title: "Renamed while responding" },
			),
		).resolves.toMatchObject({ outcome: "updated" });
		await expect(
			store.update(
				{ userId: "user-1", conversationId: "conv-1" },
				{ archived: true },
			),
		).resolves.toEqual({ outcome: "active_run" });
		await expect(
			store.deletePermanently({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).resolves.toEqual({ outcome: "active_run" });
	});

	it("Permanent deletion cascades Run history and leaves external cleanup state recoverable", async () => {
		await store.create(collectionConversation);
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sandbox-1",
		});
		await tdb.db.insert(agentSessions).values({
			conversationId: "conv-1",
			projectKey: "project-1",
			sessionId: "session-1",
			entry: { type: "user" },
		});
		await tdb.db.insert(runs).values({
			runId: "run-terminal",
			userId: "user-1",
			conversationId: "conv-1",
			status: "done",
			terminalAt: new Date(),
			nextEventSeq: 5,
		});
		await tdb.db.insert(runEvents).values([
			{ runId: "run-terminal", seq: 1, type: "run_started", payload: {} },
			{ runId: "run-terminal", seq: 2, type: "tool_call_started", payload: {} },
			{ runId: "run-terminal", seq: 3, type: "tool_call_result", payload: {} },
			{ runId: "run-terminal", seq: 4, type: "run_done", payload: {} },
		]);
		await tdb.db.insert(conversationArtifacts).values({
			artifactId: "artifact-1",
			userId: "user-1",
			conversationId: "conv-1",
			path: "report.pdf",
			objectKey: "objects/report.pdf",
			sizeBytes: 42,
			contentType: "application/pdf",
		});
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/report.pdf",
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-terminal",
			path: "report.pdf",
			status: "current",
		});

		await expect(
			store.deletePermanently({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).resolves.toEqual({ outcome: "deleted" });
		await expect(
			store.get({ userId: "user-1", conversationId: "conv-1" }),
		).resolves.toBeNull();
		expect(await tdb.db.select().from(runs)).toHaveLength(0);
		expect(await tdb.db.select().from(runEvents)).toHaveLength(0);
		expect(await tdb.db.select().from(conversationArtifacts)).toHaveLength(0);
		expect(await tdb.db.select().from(conversationRuntime)).toHaveLength(1);
		expect(await tdb.db.select().from(agentSessions)).toHaveLength(1);
		expect(await tdb.db.select().from(artifactObjects)).toHaveLength(1);
	});
});
