import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import {
	ACTIVE_RUN_STATUSES,
	conversations,
	runEvents,
	runs,
	TERMINAL_RUN_STATUSES,
} from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conv-1",
		scope: "general",
	});
});

afterAll(async () => {
	await tdb.close();
});

async function expectPartialRunIndex(
	name: string,
	columns: string,
	statuses: readonly string[],
) {
	const { rows } = await tdb.db.execute(sql`
		select indexdef from pg_indexes
		where tablename = 'runs' and indexname = ${name}
	`);
	const definition = rows[0] ? String(rows[0].indexdef) : "";
	expect(definition).toContain("CREATE INDEX");
	expect(definition).not.toContain("UNIQUE");
	expect(definition).toContain(columns);
	const [, predicate = ""] = definition.split(" WHERE ");
	for (const status of statuses) expect(predicate).toContain(status);
}

describe("run schema", () => {
	it("rejects invalid statuses", async () => {
		await expect(
			Promise.resolve(
				tdb.db.insert(runs).values({
					runId: "invalid-status",
					userId: "user-1",
					conversationId: "conv-1",
					status: "not-a-status",
				}),
			),
		).rejects.toBeDefined();
	});

	it("keeps the partial indexes aligned with the status vocabulary", async () => {
		await expectPartialRunIndex(
			"runs_conversation_active_idx",
			"(user_id, conversation_id)",
			ACTIVE_RUN_STATUSES,
		);
		await expectPartialRunIndex(
			"runs_history_paging_idx",
			"(user_id, conversation_id)",
			TERMINAL_RUN_STATUSES,
		);
		await expectPartialRunIndex(
			"runs_cleanup_idx",
			"(terminal_at)",
			TERMINAL_RUN_STATUSES,
		);
	});

	it("installs the run-event notification trigger", async () => {
		const { rows } = await tdb.db.execute(sql`
			select tgname from pg_trigger
			where tgname = 'run_events_notify_insert' and not tgisinternal
		`);
		expect(rows).toEqual([{ tgname: "run_events_notify_insert" }]);
	});

	it("rejects duplicate event sequence numbers", async () => {
		await tdb.db.insert(runs).values({
			runId: "duplicate-sequence",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
		});
		await tdb.db.insert(runEvents).values({
			runId: "duplicate-sequence",
			seq: 1,
			type: "run_started",
			payload: {},
		});

		await expect(
			Promise.resolve(
				tdb.db.insert(runEvents).values({
					runId: "duplicate-sequence",
					seq: 1,
					type: "run_started_again",
					payload: {},
				}),
			),
		).rejects.toBeDefined();
	});
});
