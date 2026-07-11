import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { Database } from "@/db/client";
import { runEvents, runs } from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import { DrizzleRunEventReader } from "./run-event-reader";

async function seedRun(db: Database, runId: string, conversationId = "conv-1") {
	await db.insert(runs).values({
		runId,
		userId: "user-1",
		conversationId,
		status: "running",
	});
}

async function appendEvent(
	db: Database,
	runId: string,
	seq: number,
	type: string,
	payload: unknown,
) {
	await db.insert(runEvents).values({ runId, seq, type, payload });
}

describe("DrizzleRunEventReader", () => {
	let tdb: TestDb;
	let db: Database;
	let reader: DrizzleRunEventReader;

	// One PGlite instance for the whole file (spin-up is the slow part); each
	// test starts from empty tables via delete, keeping isolation without the cost.
	beforeAll(async () => {
		tdb = await createTestDatabase();
		db = tdb.db;
		reader = new DrizzleRunEventReader(db);
	});

	afterAll(() => tdb.close());

	beforeEach(async () => {
		await db.delete(runs); // cascades run_events
		await seedRun(db, "run-1");
	});

	it("returns events with seq greater than the cursor, ordered by seq", async () => {
		await appendEvent(db, "run-1", 2, "assistant_text", {
			messageId: "message-1",
			text: "b",
		});
		await appendEvent(db, "run-1", 1, "run_started", { runId: "run-1" });
		await appendEvent(db, "run-1", 3, "run_done", {});

		const rows = await reader.read("run-1", 0);

		expect(rows).toEqual([
			{ seq: 1, type: "run_started", payload: { runId: "run-1" } },
			{
				seq: 2,
				type: "assistant_text",
				payload: { messageId: "message-1", text: "b" },
			},
			{ seq: 3, type: "run_done", payload: {} },
		]);
	});

	it("skips events at or below the cursor", async () => {
		await appendEvent(db, "run-1", 1, "run_started", { runId: "run-1" });
		await appendEvent(db, "run-1", 2, "assistant_text", {
			messageId: "message-1",
			text: "a",
		});
		await appendEvent(db, "run-1", 3, "run_done", {});

		expect(await reader.read("run-1", 2)).toEqual([
			{ seq: 3, type: "run_done", payload: {} },
		]);
	});

	it("limits each read so projector pagination is memory-bounded", async () => {
		await appendEvent(db, "run-1", 1, "run_started", { runId: "run-1" });
		await appendEvent(db, "run-1", 2, "assistant_text", {
			messageId: "message-1",
			text: "a",
		});
		await appendEvent(db, "run-1", 3, "run_done", {});

		expect(await reader.read("run-1", 0, 2)).toEqual([
			{ seq: 1, type: "run_started", payload: { runId: "run-1" } },
			{
				seq: 2,
				type: "assistant_text",
				payload: { messageId: "message-1", text: "a" },
			},
		]);
		expect(await reader.read("run-1", 2, 2)).toEqual([
			{ seq: 3, type: "run_done", payload: {} },
		]);
	});

	it("does not return events belonging to another run", async () => {
		await seedRun(db, "run-2", "conv-2");
		await appendEvent(db, "run-1", 1, "assistant_text", {
			messageId: "message-1",
			text: "mine",
		});
		await appendEvent(db, "run-2", 1, "assistant_text", {
			messageId: "message-2",
			text: "theirs",
		});

		expect(await reader.read("run-1", 0)).toEqual([
			{
				seq: 1,
				type: "assistant_text",
				payload: { messageId: "message-1", text: "mine" },
			},
		]);
	});

	it("returns an empty array when there are no new events", async () => {
		expect(await reader.read("run-1", 0)).toEqual([]);
	});
});
