import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "./client";
import * as schema from "./schema";

/**
 * Test-only. Spins up an in-process Postgres (pglite) with every `drizzle/`
 * migration applied, wrapped in a Drizzle client, so the Postgres-backed stores
 * run their real SQL — composite PK, ON CONFLICT, defaults — without an external
 * database. Cast to {@link Database} because pglite and the bun-sql production
 * driver share the same query builder but differ in static type.
 *
 * Always `close()` the returned handle (e.g. in `afterEach`): an unclosed pglite
 * instance leaks resources and makes `bun test` exit non-zero even when every
 * assertion passes.
 */
export interface TestDb {
	db: Database;
	close: () => Promise<void>;
}

const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");

export async function createTestDatabase(): Promise<TestDb> {
	const client = new PGlite();
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const file of files) {
		const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
		for (const stmt of sql.split("--> statement-breakpoint")) {
			if (stmt.trim()) await client.exec(stmt);
		}
	}
	return {
		db: drizzle(client, { schema }) as unknown as Database,
		close: () => client.close(),
	};
}
