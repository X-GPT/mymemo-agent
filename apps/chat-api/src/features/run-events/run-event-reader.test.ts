import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "@/db/client";
import { runEvents, runs } from "@/db/schema";
import { createTestDatabase } from "@/db/testing";
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
	let db: Database;
	let close: () => Promise<void>;
	let reader: DrizzleRunEventReader;

	beforeEach(async () => {
		const tdb = await createTestDatabase();
		db = tdb.db;
		close = tdb.close;
		reader = new DrizzleRunEventReader(db);
		await seedRun(db, "run-1");
	});

	afterEach(() => close());

	it("returns events with seq greater than the cursor, ordered by seq", async () => {
		await appendEvent(db, "run-1", 2, "assistant_text", { text: "b" });
		await appendEvent(db, "run-1", 1, "run_started", { runId: "run-1" });
		await appendEvent(db, "run-1", 3, "run_done", {});

		const rows = await reader.read("run-1", 0);

		expect(rows).toEqual([
			{ seq: 1, type: "run_started", payload: { runId: "run-1" } },
			{ seq: 2, type: "assistant_text", payload: { text: "b" } },
			{ seq: 3, type: "run_done", payload: {} },
		]);
	});

	it("skips events at or below the cursor", async () => {
		await appendEvent(db, "run-1", 1, "run_started", { runId: "run-1" });
		await appendEvent(db, "run-1", 2, "assistant_text", { text: "a" });
		await appendEvent(db, "run-1", 3, "run_done", {});

		expect(await reader.read("run-1", 2)).toEqual([
			{ seq: 3, type: "run_done", payload: {} },
		]);
	});

	it("does not return events belonging to another run", async () => {
		await seedRun(db, "run-2", "conv-2");
		await appendEvent(db, "run-1", 1, "assistant_text", { text: "mine" });
		await appendEvent(db, "run-2", 1, "assistant_text", { text: "theirs" });

		expect(await reader.read("run-1", 0)).toEqual([
			{ seq: 1, type: "assistant_text", payload: { text: "mine" } },
		]);
	});

	it("returns an empty array when there are no new events", async () => {
		expect(await reader.read("run-1", 0)).toEqual([]);
	});
});
