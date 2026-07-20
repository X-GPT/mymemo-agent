import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { loadRunStartedTx } from "@mymemo/agent-db/run-store";
import { eq } from "drizzle-orm";
import { conversations, runEvents, runs } from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import {
	type ConversationRecord,
	PostgresConversationStore,
} from "@/features/conversation-store";
import {
	ActiveRunExistsError,
	ConversationArchivedError,
	ConversationNotFoundError,
	PostgresRunStore,
	RunInputMismatchError,
} from "./run-store";

const initialActivity = new Date("2026-01-01T00:00:00.000Z");
const conversation: ConversationRecord = {
	userId: "user-1",
	conversationId: "conv-1",
	scope: "collection",
	collectionId: "col-1",
	summaryId: null,
	title: null,
	createdAt: initialActivity,
	lastActivityAt: initialActivity,
	archivedAt: null,
};

describe("PostgresRunStore", () => {
	let tdb: TestDb;
	let store: PostgresRunStore;
	let conversationStore: PostgresConversationStore;

	// One PGlite instance for the whole file (spin-up is the slow part); each
	// test starts from an empty runs table via delete, keeping isolation without
	// the cost. The conversation seed is stable, so it is inserted once.
	beforeAll(async () => {
		tdb = await createTestDatabase();
		store = new PostgresRunStore(tdb.db);
		conversationStore = new PostgresConversationStore(tdb.db);
		await tdb.db.insert(conversations).values(conversation);
	});

	afterAll(() => tdb.close());

	afterEach(async () => {
		await tdb.db.delete(runs); // cascades run_events
		await tdb.db
			.insert(conversations)
			.values(conversation)
			.onConflictDoUpdate({
				target: [conversations.userId, conversations.conversationId],
				set: {
					title: null,
					lastActivityAt: initialActivity,
					archivedAt: null,
				},
			});
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

	it("admits a caller-prepared Run id transactionally", async () => {
		const result = await store.createQueuedRun({
			conversation,
			message: "hello",
			runId: "prepared-run-id",
		});

		expect(result).toEqual({ runId: "prepared-run-id" });
		await expect(
			loadRunStartedTx(tdb.db, { runId: "prepared-run-id" }),
		).resolves.toMatchObject({ message: "hello" });
	});

	it("idempotently admits one canonical AG-UI Run input", async () => {
		const input = {
			conversation,
			runId: "client-run-1",
			messageId: "user-message-1",
			message: "hello from AG-UI",
		};

		await expect(store.admitRun(input)).resolves.toMatchObject({
			outcome: "created",
			run: {
				runId: "client-run-1",
				normalizedInput: {
					version: 1,
					messageId: "user-message-1",
					text: "hello from AG-UI",
				},
			},
		});
		await expect(store.admitRun(input)).resolves.toMatchObject({
			outcome: "existing",
			run: { runId: "client-run-1" },
		});

		expect(
			await tdb.db
				.select()
				.from(runEvents)
				.where(eq(runEvents.runId, "client-run-1")),
		).toHaveLength(1);
		await expect(
			store.admitRun({ ...input, message: "different work" }),
		).rejects.toBeInstanceOf(RunInputMismatchError);
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

	it("first admitted User message initializes title and advances activity atomically", async () => {
		await store.createQueuedRun({
			conversation,
			message: "Summarize the quarterly plan",
		});

		await expect(
			conversationStore.get({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).resolves.toMatchObject({
			title: "Summarize the quarterly plan",
		});
		const persisted = await conversationStore.get({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(persisted?.lastActivityAt.getTime()).toBeGreaterThan(
			initialActivity.getTime(),
		);
	});

	it("later admission advances activity without replacing an explicit title", async () => {
		await conversationStore.update(
			{ userId: "user-1", conversationId: "conv-1" },
			{ title: "Quarterly planning" },
		);

		await store.createQueuedRun({
			conversation,
			message: "What changed this week?",
		});

		await expect(
			conversationStore.get({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).resolves.toMatchObject({
			title: "Quarterly planning",
		});
		const persisted = await conversationStore.get({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(persisted?.lastActivityAt.getTime()).toBeGreaterThan(
			initialActivity.getTime(),
		);
	});

	it("failed admission leaves title and activity unchanged", async () => {
		await store.createQueuedRun({ conversation, message: "first" });
		const before = await conversationStore.get({
			userId: "user-1",
			conversationId: "conv-1",
		});

		await expect(
			store.createQueuedRun({ conversation, message: "must not commit" }),
		).rejects.toBeInstanceOf(ActiveRunExistsError);

		const after = await conversationStore.get({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(after?.title).toBe(before?.title);
		expect(after?.lastActivityAt).toEqual(before?.lastActivityAt);
	});

	it("serializes Archive before admission and rejects the new Run", async () => {
		await expect(
			conversationStore.update(
				{ userId: "user-1", conversationId: "conv-1" },
				{ archived: true },
			),
		).resolves.toMatchObject({ outcome: "updated" });

		await expect(
			store.createQueuedRun({ conversation, message: "too late" }),
		).rejects.toBeInstanceOf(ConversationArchivedError);
		expect(await tdb.db.select().from(runs)).toHaveLength(0);
	});

	it("serializes admission before Archive and rejects the lifecycle change", async () => {
		await store.createQueuedRun({ conversation, message: "admitted first" });

		await expect(
			conversationStore.update(
				{ userId: "user-1", conversationId: "conv-1" },
				{ archived: true },
			),
		).resolves.toEqual({ outcome: "active_run" });
	});

	it("serializes permanent deletion racing admission", async () => {
		const deletion = conversationStore.deletePermanently({
			userId: "user-1",
			conversationId: "conv-1",
		});
		const admission = store.createQueuedRun({
			conversation,
			message: "racing deletion",
		});

		const [deletionResult, admissionResult] = await Promise.allSettled([
			deletion,
			admission,
		]);
		expect(deletionResult.status).toBe("fulfilled");
		if (deletionResult.status !== "fulfilled") return;

		if (deletionResult.value.outcome === "deleted") {
			expect(admissionResult.status).toBe("rejected");
			if (admissionResult.status === "rejected") {
				expect(admissionResult.reason).toBeInstanceOf(
					ConversationNotFoundError,
				);
			}
			expect(await tdb.db.select().from(runs)).toHaveLength(0);
			return;
		}

		expect(deletionResult.value).toEqual({ outcome: "active_run" });
		expect(admissionResult.status).toBe("fulfilled");
		expect(await tdb.db.select().from(runs)).toHaveLength(1);
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
