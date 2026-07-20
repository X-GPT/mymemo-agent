import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_DIR } from "./migrations";

let db: PGlite;

beforeAll(async () => {
	db = new PGlite();
	await db.waitReady;
	await db.exec(`
		CREATE TABLE conversations (
			user_id text NOT NULL,
			conversation_id text NOT NULL,
			scope text NOT NULL,
			collection_id text,
			summary_id text,
			created_at timestamptz NOT NULL,
			PRIMARY KEY (user_id, conversation_id)
		);
		CREATE TABLE runs (
			run_id text PRIMARY KEY,
			user_id text NOT NULL,
			conversation_id text NOT NULL,
			created_at timestamptz NOT NULL
		);
		INSERT INTO conversations
			(user_id, conversation_id, scope, created_at)
		VALUES
			('user-1', 'with-run', 'general', '2026-01-01T00:00:00Z'),
			('user-1', 'empty', 'general', '2026-01-03T00:00:00Z');
		INSERT INTO runs (run_id, user_id, conversation_id, created_at)
		VALUES ('run-1', 'user-1', 'with-run', '2026-01-02T00:00:00Z');
	`);

	for (const file of [
		"0008_careless_proteus.sql",
		"0009_backfill_conversation_activity.sql",
	]) {
		const migration = await readFile(join(MIGRATIONS_DIR, file), "utf8");
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await db.exec(statement);
		}
	}
});

afterAll(async () => {
	await db.close();
});

describe("Conversation lifecycle migration", () => {
	it("preserves existing records, backfills activity, and cascades future deletion", async () => {
		const result = await db.query<{
			conversation_id: string;
			title: string | null;
			last_activity_at: Date;
			archived_at: Date | null;
		}>(`
			SELECT conversation_id, title, last_activity_at, archived_at
			FROM conversations
			ORDER BY conversation_id
		`);
		expect(
			result.rows.map((row) => ({
				...row,
				last_activity_at: row.last_activity_at.toISOString(),
			})),
		).toEqual([
			{
				conversation_id: "empty",
				title: null,
				last_activity_at: "2026-01-03T00:00:00.000Z",
				archived_at: null,
			},
			{
				conversation_id: "with-run",
				title: null,
				last_activity_at: "2026-01-02T00:00:00.000Z",
				archived_at: null,
			},
		]);
		expect((await db.query("SELECT run_id FROM runs")).rows).toHaveLength(1);

		await db.exec(
			"DELETE FROM conversations WHERE user_id = 'user-1' AND conversation_id = 'with-run'",
		);
		expect((await db.query("SELECT run_id FROM runs")).rows).toHaveLength(0);
	});
});
