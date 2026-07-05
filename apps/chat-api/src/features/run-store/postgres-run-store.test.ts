import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, runEvents, runs } from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import type { ConversationRecord } from "@/features/conversation-store";
import { ActiveRunExistsError, PostgresRunStore } from "./run-store";

const conversation: ConversationRecord = {
	userId: "user-1",
	conversationId: "conv-1",
	scope: "collection",
	collectionId: "col-1",
	summaryId: null,
};

describe("PostgresRunStore", () => {
	let tdb: TestDb;
	let store: PostgresRunStore;

	beforeEach(async () => {
		tdb = await createTestDatabase();
		store = new PostgresRunStore(tdb.db);
		await tdb.db.insert(conversations).values(conversation);
	});

	afterEach(() => tdb.close());

	it("creates one queued run and records run_started transactionally", async () => {
		const result = await store.createQueuedRun({
			conversation,
			message: "hello",
		});

		const [run] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, result.runId));
		expect(run).toMatchObject({
			runId: result.runId,
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			nextEventSeq: 2,
		});

		const events = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, result.runId));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			seq: 1,
			type: "run_started",
		});
		expect(events[0]?.payload).toMatchObject({
			runId: result.runId,
			conversationId: "conv-1",
			message: "hello",
			scope: "collection",
			collectionId: "col-1",
			summaryId: null,
		});
	});

	it("surfaces the active-run unique index as backpressure", async () => {
		await store.createQueuedRun({ conversation, message: "first" });

		await expect(
			store.createQueuedRun({ conversation, message: "second" }),
		).rejects.toThrow(ActiveRunExistsError);
	});

	it("lists replay events after a sequence number", async () => {
		const { runId } = await store.createQueuedRun({
			conversation,
			message: "hello",
		});
		await tdb.db.insert(runEvents).values({
			runId,
			seq: 2,
			type: "text_delta",
			payload: { text: "hi" },
		});

		const replay = await store.listRunEventsAfter({ runId, afterSeq: 1 });
		expect(replay).toEqual([
			{ runId, seq: 2, type: "text_delta", payload: { text: "hi" } },
		]);
	});

	it("gets a run only for its owning user and conversation", async () => {
		const { runId } = await store.createQueuedRun({
			conversation,
			message: "hello",
		});

		await expect(
			store.getRun({
				userId: "user-1",
				conversationId: "conv-1",
				runId,
			}),
		).resolves.toMatchObject({
			runId,
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
		});
		await expect(
			store.getRun({
				userId: "other",
				conversationId: "conv-1",
				runId,
			}),
		).resolves.toBeNull();
	});
});
