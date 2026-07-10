import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { loadRunStartedTx } from "@mymemo/agent-db/run-store";
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

	// One PGlite instance for the whole file (spin-up is the slow part); each
	// test starts from an empty runs table via delete, keeping isolation without
	// the cost. The conversation seed is stable, so it is inserted once.
	beforeAll(async () => {
		tdb = await createTestDatabase();
		store = new PostgresRunStore(tdb.db);
		await tdb.db.insert(conversations).values(conversation);
	});

	afterAll(() => tdb.close());

	afterEach(async () => {
		await tdb.db.delete(runs); // cascades run_events; keeps the conversation seed
	});

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

	// Guards the write/read contract across the trust boundary: the worker's
	// orchestration loads the turn through the shared helper, so what admission
	// writes must be exactly what it reads back.
	it("round-trips the run_started payload through loadRunStartedTx", async () => {
		const { runId } = await store.createQueuedRun({
			conversation,
			message: "summarize my notes",
		});

		const started = await loadRunStartedTx(tdb.db, { runId });

		expect(started).toEqual({
			message: "summarize my notes",
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
			type: "assistant_text",
			payload: { messageId: "message-1", text: "hi" },
		});

		const replay = await store.listRunEventsAfter({ runId, afterSeq: 1 });
		expect(replay).toEqual([
			{
				runId,
				seq: 2,
				type: "assistant_text",
				payload: { messageId: "message-1", text: "hi" },
			},
		]);
	});

	it("requests cancellation scoped to the owning user and conversation", async () => {
		const { runId } = await store.createQueuedRun({
			conversation,
			message: "hello",
		});

		await expect(
			store.requestCancellation({
				userId: "other",
				conversationId: "conv-1",
				runId,
			}),
		).resolves.toEqual({ outcome: "not_found" });

		const result = await store.requestCancellation({
			userId: "user-1",
			conversationId: "conv-1",
			runId,
		});
		expect(result.outcome).toBe("canceled");
		if (result.outcome !== "canceled") throw new Error("unreachable");
		expect(result.run.status).toBe("canceled");
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
