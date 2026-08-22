import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { loadRunStartedTx } from "@mymemo/agent-db/run-store";
import { eq } from "drizzle-orm";
import {
	agentCoreDispatchOutbox,
	conversations,
	runEvents,
	runs,
} from "@/db/schema";
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

function runInput(runId: string, message: string) {
	return {
		conversation,
		runId,
		messageId: `message-${runId}`,
		message,
	};
}

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
		await tdb.db.delete(agentCoreDispatchOutbox);
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

	it("creates one queued AG-UI Run and records run_started transactionally", async () => {
		await expect(
			store.admitRun(runInput("run-1", "hello")),
		).resolves.toMatchObject({
			outcome: "created",
		});

		const [run] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-1"));
		expect(run).toMatchObject({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			nextEventSeq: 2,
		});

		const events = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			seq: 1,
			type: "run_started",
		});
		expect(events[0]?.payload).toMatchObject({
			runId: "run-1",
			conversationId: "conv-1",
			messageId: "message-run-1",
			message: "hello",
			scope: "collection",
			collectionId: "col-1",
			summaryId: null,
		});
	});

	it("records one dispatch with a newly admitted AgentCore Run", async () => {
		await expect(
			store.admitRun(runInput("run-agentcore", "hello AgentCore")),
		).resolves.toMatchObject({ outcome: "created" });

		expect(await tdb.db.select().from(runs)).toMatchObject([
			{ runId: "run-agentcore", status: "queued" },
		]);
		expect(await tdb.db.select().from(agentCoreDispatchOutbox)).toMatchObject([
			{
				runId: "run-agentcore",
				userId: "user-1",
				conversationId: "conv-1",
			},
		]);
	});

	it("reattaches an exact AgentCore retry without a second dispatch", async () => {
		const input = runInput("run-agentcore-retry", "retry-safe work");

		await expect(store.admitRun(input)).resolves.toMatchObject({
			outcome: "created",
		});
		await expect(store.admitRun(input)).resolves.toMatchObject({
			outcome: "existing",
		});

		expect(await tdb.db.select().from(agentCoreDispatchOutbox)).toHaveLength(1);
	});

	it("rolls back an AgentCore Run when dispatch recording fails", async () => {
		await tdb.db.insert(agentCoreDispatchOutbox).values({
			runId: "run-dispatch-conflict",
			userId: "preexisting-user",
			conversationId: "preexisting-conversation",
		});

		await expect(
			store.admitRun(
				runInput("run-dispatch-conflict", "must roll back with dispatch"),
			),
		).rejects.toThrow();

		expect(await tdb.db.select().from(runs)).toEqual([]);
		expect(await tdb.db.select().from(runEvents)).toEqual([]);
		expect(await tdb.db.select().from(agentCoreDispatchOutbox)).toMatchObject([
			{
				runId: "run-dispatch-conflict",
				userId: "preexisting-user",
			},
		]);
	});

	it("does not record a dispatch when AgentCore Run admission rolls back", async () => {
		await store.admitRun(runInput("run-active", "first"));

		await expect(
			store.admitRun(runInput("run-rejected", "must not dispatch")),
		).rejects.toBeInstanceOf(ActiveRunExistsError);

		expect(
			await tdb.db
				.select()
				.from(agentCoreDispatchOutbox)
				.where(eq(agentCoreDispatchOutbox.runId, "run-rejected")),
		).toEqual([]);
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

	it("surfaces a different active AG-UI Run id as route backpressure", async () => {
		const input = {
			conversation,
			runId: "client-run-1",
			messageId: "user-message-1",
			message: "first work",
		};
		await store.admitRun(input);

		await expect(
			store.admitRun({
				...input,
				runId: "client-run-2",
				messageId: "user-message-2",
				message: "competing work",
			}),
		).rejects.toBeInstanceOf(ActiveRunExistsError);
	});

	// Guards the write/read contract across the trust boundary: the worker's
	// orchestration loads the turn through the shared helper, so what admission
	// writes must be exactly what it reads back.
	it("round-trips the run_started payload through loadRunStartedTx", async () => {
		const runId = "run-round-trip";
		await store.admitRun(runInput(runId, "summarize my notes"));

		const started = await loadRunStartedTx(tdb.db, { runId });

		expect(started).toEqual({
			message: "summarize my notes",
			scope: "collection",
			collectionId: "col-1",
			summaryId: null,
		});
	});

	it("first admitted User message initializes title and advances activity atomically", async () => {
		await store.admitRun(runInput("run-title", "Summarize the quarterly plan"));

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

		await store.admitRun(runInput("run-later", "What changed this week?"));

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
		await store.admitRun(runInput("run-first", "first"));
		const before = await conversationStore.get({
			userId: "user-1",
			conversationId: "conv-1",
		});

		await expect(
			store.admitRun(runInput("run-conflict", "must not commit")),
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
			store.admitRun(runInput("run-too-late", "too late")),
		).rejects.toBeInstanceOf(ConversationArchivedError);
		expect(await tdb.db.select().from(runs)).toHaveLength(0);
	});

	it("serializes admission before Archive and rejects the lifecycle change", async () => {
		await store.admitRun(runInput("run-admitted", "admitted first"));

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
		const admission = store.admitRun(runInput("run-racing", "racing deletion"));

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

	it("requests interruption scoped to the owning user and conversation", async () => {
		const runId = "run-interrupt";
		await store.admitRun(runInput(runId, "hello"));

		await expect(
			store.requestInterruption({
				userId: "other",
				conversationId: "conv-1",
				runId,
			}),
		).resolves.toEqual({ outcome: "not_found" });

		const result = await store.requestInterruption({
			userId: "user-1",
			conversationId: "conv-1",
			runId,
		});
		expect(result.outcome).toBe("interrupted");
		if (result.outcome !== "interrupted") throw new Error("unreachable");
		expect(result.run.status).toBe("interrupted");
	});

	it("gets a run only for its owning user and conversation", async () => {
		const runId = "run-get";
		await store.admitRun(runInput(runId, "hello"));

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
