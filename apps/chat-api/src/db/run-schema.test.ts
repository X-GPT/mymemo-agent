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
import {
	ACTIVE_RUN_STATUSES,
	conversations,
	documentAccessEvents,
	runEvents,
	runs,
	TERMINAL_RUN_STATUSES,
} from "./schema";

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
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values([
		{
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "agentcore",
		},
		{
			userId: "user-1",
			conversationId: "conv-2",
			scope: "general",
			executionRuntime: "agentcore",
		},
	]);
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
	it("retains only the AgentCore compatibility marker", async () => {
		const { rows: columns } = await tdb.db.execute(sql`
			select table_name, column_name
			from information_schema.columns
			where table_schema = 'public'
				and table_name in ('conversations', 'execution_runtime_deployments')
				and column_name in ('execution_runtime', 'runtime_aware')
			order by table_name, column_name
		`);
		expect(columns).toEqual([
			{ table_name: "conversations", column_name: "execution_runtime" },
		]);
		const { rows: retiredTables } = await tdb.db.execute(sql`
			select tablename
			from pg_tables
			where schemaname = 'public'
				and tablename in ('execution_lane_deployments', 'execution_runtime_deployments')
		`);
		expect(retiredTables).toEqual([]);
		await expectDbWriteToFail(() =>
			tdb.db.execute(sql`
				update ${conversations}
				set execution_runtime = 'agentcore_canary'
				where conversation_id = 'conv-1'
			`),
		);
	});

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
			executedByWorkerId: null,
			interruptRequestedAt: null,
			normalizedInput: null,
			liveStreamFailedAt: null,
			nextEventSeq: 1,
			terminalAt: null,
		});
		expect(run?.createdAt).toBeInstanceOf(Date);
		expect(run?.updatedAt).toBeInstanceOf(Date);
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

	it("accepts the interruption status vocabulary", async () => {
		await tdb.db.insert(runs).values([
			{
				runId: "run-interrupt-requested",
				userId: "user-1",
				conversationId: "conv-1",
				status: "interrupt_requested",
			},
			{
				runId: "run-interrupted",
				userId: "user-1",
				conversationId: "conv-2",
				status: "interrupted",
			},
		]);
	});

	it("has only the retained conversation and cleanup indexes", async () => {
		const { rows } = await tdb.db.execute(sql`
			select indexname from pg_indexes where tablename = 'runs'
		`);
		const names = rows.map((row) => row.indexname);
		expect(names).toContain("runs_conversation_active_idx");
		expect(names).not.toContain("runs_queue_claim_idx");
		expect(names).toContain("runs_cleanup_idx");
		expect(names).not.toContain("runs_stale_recovery_idx");
		expect(names).not.toContain("runs_one_active_per_conversation");
	});

	it("keeps the conversation-active index non-unique and partial", async () => {
		// The access path is wanted; the constraint is not. A regenerated schema
		// that made this UNIQUE would silently reinstate the database-enforced
		// Active Run bound this epic deliberately replaced — and the partial
		// predicate is what keeps the index sized by busy conversations rather
		// than by every Run ever admitted.
		const { rows } = await tdb.db.execute(sql`
			select indexdef from pg_indexes
			where tablename = 'runs' and indexname = 'runs_conversation_active_idx'
		`);
		// Empty when the index is missing, which fails the first assertion loudly.
		const definition = rows[0] ? String(rows[0].indexdef) : "";
		expect(definition).toContain("CREATE INDEX");
		expect(definition).not.toContain("UNIQUE");
		expect(definition).toContain("(user_id, conversation_id)");
		// Asserted by parts rather than as one string: Postgres normalizes an `in`
		// list into its own `= ANY (ARRAY[...])` rendering, and pinning that exact
		// spelling would make the test a hostage to the server version.
		const [, predicate = ""] = definition.split(" WHERE ");
		expect(predicate).toContain("status");
		// Read from the shared tuple, so this asserts that what the database
		// actually indexes is what admission actually filters on.
		for (const status of ACTIVE_RUN_STATUSES) {
			expect(predicate).toContain(status);
		}
	});

	it("keeps the history-paging index partial on Outcomes", async () => {
		const { rows } = await tdb.db.execute(sql`
			select indexdef from pg_indexes
			where tablename = 'runs' and indexname = 'runs_history_paging_idx'
		`);
		// Empty when the index is missing, which fails the first assertion loudly.
		// A unique index would fail it too — `CREATE UNIQUE INDEX` does not contain
		// this substring.
		const definition = rows[0] ? String(rows[0].indexdef) : "";
		expect(definition).toContain("CREATE INDEX");
		// Exactly the equality pair, nothing trailing it; the index's own comment
		// in `schema.ts` carries why ordering columns would buy nothing here.
		expect(definition).toContain("(user_id, conversation_id)");
		// Asserted by parts rather than as one string, for the same reason as
		// `runs_conversation_active_idx` above.
		const [, predicate = ""] = definition.split(" WHERE ");
		expect(predicate).toContain("status");
		// Read from the shared tuple, so this catches a change to what counts as
		// an Outcome that never reached the migration the database actually ran.
		for (const status of TERMINAL_RUN_STATUSES) {
			expect(predicate).toContain(status);
		}
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
				type: "assistant_message_completed",
				payload: { messageId: "message-1", text: "hello" },
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
			"assistant_message_completed",
		]);
	});

	it("has no retired Fargate doorbell triggers or functions", async () => {
		const { rows: triggers } = await tdb.db.execute(sql`
			select tgname, pg_get_triggerdef(oid) as def
			from pg_trigger
			where tgrelid = 'runs'::regclass and not tgisinternal
			order by tgname
		`);
		expect(triggers).toEqual([]);
		const { rows: functions } = await tdb.db.execute(sql`
			select proname, pg_get_functiondef(oid) as def from pg_proc
			where proname in ('notify_run_doorbell', 'notify_run_queued')
		`);
		expect(functions).toEqual([]);
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
				operation: "search",
				scopeType: "collection",
				scopeId: "coll-1",
				query: "quarterly report",
				documentIds: ["doc-1", "doc-2"],
				resultCount: 3,
			})
			.returning();

		expect(event).toMatchObject({
			runId: "run-1",
			conversationId: "conv-1",
			userId: "user-1",
			operation: "search",
			scopeType: "collection",
			scopeId: "coll-1",
			query: "quarterly report",
			documentIds: ["doc-1", "doc-2"],
			resultCount: 3,
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
				operation: "list",
				scopeType: "general",
				documentIds: [],
			})
			.returning();

		expect(event).toMatchObject({
			operation: "list",
			scopeType: "general",
			scopeId: null,
			query: null,
			documentIds: [],
			resultCount: null,
		});
	});

	it("rejects invalid scope types", async () => {
		await expectDbWriteToFail(() =>
			tdb.db.insert(documentAccessEvents).values({
				runId: "run-1",
				conversationId: "conv-1",
				userId: "user-1",
				operation: "search",
				scopeType: "everything",
				documentIds: [],
			}),
		);
	});

	it("rejects invalid operations", async () => {
		await expectDbWriteToFail(() =>
			tdb.db.insert(documentAccessEvents).values({
				runId: "run-1",
				conversationId: "conv-1",
				userId: "user-1",
				operation: "enumerate",
				scopeType: "general",
				documentIds: [],
			}),
		);
	});
});
