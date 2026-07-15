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
		CREATE TABLE document_access_events (
			id bigserial PRIMARY KEY,
			query text
		);
		INSERT INTO document_access_events (query) VALUES ('roadmap'), (NULL);
	`);
	const migration = await readFile(
		join(MIGRATIONS_DIR, "0004_eager_puff_adder.sql"),
		"utf8",
	);
	for (const statement of migration.split("--> statement-breakpoint")) {
		if (statement.trim()) await db.exec(statement);
	}
});

afterAll(async () => {
	await db.close();
});

describe("document access operation migration", () => {
	it("backfills historical rows without inventing result counts", async () => {
		const result = await db.query<{
			operation: string;
			result_count: number | null;
		}>(
			"SELECT operation, result_count FROM document_access_events ORDER BY id",
		);
		expect(result.rows).toEqual([
			{ operation: "search", result_count: null },
			{ operation: "load", result_count: null },
		]);
	});

	it("enforces the operation vocabulary for new rows", async () => {
		await expect(
			db.exec(
				"INSERT INTO document_access_events (query, operation) VALUES (NULL, 'enumerate')",
			),
		).rejects.toThrow();
	});
});
