import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDatabase, type TestDb } from "@/db/testing";
import { documentAccessEvents, runEvents, runs } from "./schema";

let tdb: TestDb;

// One PGlite (WASM) instance for the whole file — a per-test instance
// multiplies WASM memory that is not reclaimed promptly and OOMs CI runners.
// Tests are isolated by clearing the tables they touch instead.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(documentAccessEvents);
});

async function expectDbWriteToFail(write: () => PromiseLike<unknown>) {
	let failed = false;
	try {
		await write();
	} catch {
		failed = true;
	}
	expect(failed).toBe(true);
}

describe("run queue schema", () => {
	it("creates runs with queue defaults", async () => {
		const [run] = await tdb.db
			.insert(runs)
			.values({
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "queued",
			})
			.returning();

		expect(run).toMatchObject({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			lockedBy: null,
			lockedUntil: null,
			heartbeatAt: null,
			cancelRequestedAt: null,
			nextEventSeq: 1,
			terminalAt: null,
		});
		expect(run?.createdAt).toBeInstanceOf(Date);
		expect(run?.updatedAt).toBeInstanceOf(Date);
	});

	it("carries no fencing_token or visibility columns (rebaselined)", async () => {
		const { rows } = await tdb.db.execute(sql`
			select table_name, column_name
			from information_schema.columns
			where table_name in ('runs', 'run_events')
				and column_name in ('fencing_token', 'visibility')
		`);
		expect(rows).toEqual([]);
	});

	it("rejects invalid run statuses", async () => {
		await expectDbWriteToFail(() =>
			tdb.db.insert(runs).values({
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "not-a-status",
			}),
		);
	});

	it("enforces one active run per conversation", async () => {
		await tdb.db.insert(runs).values({
			runId: "run-active-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
		});

		await expectDbWriteToFail(() =>
			tdb.db.insert(runs).values({
				runId: "run-active-2",
				userId: "user-1",
				conversationId: "conv-1",
				status: "running",
			}),
		);
	});

	it("terminal runs do not block a later run for the same conversation", async () => {
		await tdb.db.insert(runs).values({
			runId: "run-finished",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
		});
		await tdb.db
			.update(runs)
			.set({ status: "done" })
			.where(eq(runs.runId, "run-finished"));

		await tdb.db.insert(runs).values({
			runId: "run-next",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
		});
	});

	it("allows active runs for different conversations", async () => {
		await tdb.db.insert(runs).values([
			{
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "queued",
			},
			{
				runId: "run-2",
				userId: "user-1",
				conversationId: "conv-2",
				status: "queued",
			},
		]);
	});

	it("has the queue-claim, stale-recovery, and cleanup indexes", async () => {
		const { rows } = await tdb.db.execute(sql`
			select indexname from pg_indexes where tablename = 'runs'
		`);
		const names = rows.map((row) => row.indexname);
		expect(names).toContain("runs_queue_claim_idx");
		expect(names).toContain("runs_stale_recovery_idx");
		expect(names).toContain("runs_cleanup_idx");
		expect(names).toContain("runs_one_active_per_conversation");
	});

	it("records ordered run events", async () => {
		await tdb.db.insert(runs).values({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
		});

		await tdb.db.insert(runEvents).values([
			{
				runId: "run-1",
				seq: 1,
				type: "run_started",
				payload: { workerId: "worker-1" },
			},
			{
				runId: "run-1",
				seq: 2,
				type: "text_delta",
				payload: { text: "hello" },
			},
		]);

		const events = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"))
			.orderBy(runEvents.seq);

		expect(events.map((event) => event.seq)).toEqual([1, 2]);
		expect(events.map((event) => event.type)).toEqual([
			"run_started",
			"text_delta",
		]);
	});

	it("installs a trigger that notifies listeners when run events are inserted", async () => {
		const { rows } = await tdb.db.execute(sql`
			select tgname
			from pg_trigger
			where tgname = 'run_events_notify_insert'
				and not tgisinternal
		`);
		expect(rows).toEqual([{ tgname: "run_events_notify_insert" }]);
	});

	it("rejects duplicate event sequence numbers", async () => {
		await tdb.db.insert(runs).values({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
		});
		await tdb.db.insert(runEvents).values({
			runId: "run-1",
			seq: 1,
			type: "run_started",
			payload: {},
		});

		await expectDbWriteToFail(() =>
			tdb.db.insert(runEvents).values({
				runId: "run-1",
				seq: 1,
				type: "run_started_again",
				payload: {},
			}),
		);
	});
});

describe("document access audit schema", () => {
	it("records document access rows with defaults", async () => {
		const [event] = await tdb.db
			.insert(documentAccessEvents)
			.values({
				runId: "run-1",
				conversationId: "conv-1",
				userId: "user-1",
				scopeType: "collection",
				scopeId: "coll-1",
				query: "quarterly report",
				documentIds: ["doc-1", "doc-2"],
			})
			.returning();

		expect(event).toMatchObject({
			runId: "run-1",
			conversationId: "conv-1",
			userId: "user-1",
			scopeType: "collection",
			scopeId: "coll-1",
			query: "quarterly report",
			documentIds: ["doc-1", "doc-2"],
		});
		expect(event?.id).toBeGreaterThan(0);
		expect(event?.createdAt).toBeInstanceOf(Date);
	});

	it("allows general scope without scope id or query", async () => {
		const [event] = await tdb.db
			.insert(documentAccessEvents)
			.values({
				runId: "run-1",
				conversationId: "conv-1",
				userId: "user-1",
				scopeType: "general",
				documentIds: [],
			})
			.returning();

		expect(event).toMatchObject({
			scopeType: "general",
			scopeId: null,
			query: null,
			documentIds: [],
		});
	});

	it("rejects invalid scope types", async () => {
		await expectDbWriteToFail(() =>
			tdb.db.insert(documentAccessEvents).values({
				runId: "run-1",
				conversationId: "conv-1",
				userId: "user-1",
				scopeType: "everything",
				documentIds: [],
			}),
		);
	});
});
