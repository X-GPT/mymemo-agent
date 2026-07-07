import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "./client";
import { MIGRATIONS_DIR } from "./migrations";
import * as schema from "./schema";

/**
 * Test-only. Spins up an in-process Postgres (pglite) with every `drizzle/`
 * migration applied, wrapped in a Drizzle client, so the Postgres-backed stores
 * run their real SQL — composite PK, ON CONFLICT, defaults — without an external
 * database. Cast to {@link Database} because pglite and the node-postgres
 * production driver share the same query builder but differ in static type.
 *
 * Shared by chat-api and agent-worker tests: both replay this package's
 * migrations, so the two apps exercise the identical writable-DB schema.
 *
 * Always `close()` the returned handle (e.g. in `afterEach`): an unclosed pglite
 * instance leaks resources and makes `bun test` exit non-zero even when every
 * assertion passes.
 */
export interface TestDb {
	db: Database;
	close: () => Promise<void>;
}

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
		close: async () => {
			await client.close();
			// pglite holds its Postgres heap in WASM linear memory that `close()`
			// releases only for the WASM instance — the ~1GB backing ArrayBuffer is
			// reclaimed lazily by the JS GC. A suite that spins up one instance per
			// test leaves those closed corpses uncollected, so peak memory climbs
			// until a later `new PGlite()` cannot allocate and fails to initialize
			// (a flaky, GC-timing-dependent CI OOM). Forcing a collection here caps
			// peak at a single live instance; it costs ~17ms next to pglite's ~1.5s
			// spin-up, so it is free relative to the test it guards.
			if (typeof Bun !== "undefined") Bun.gc(true);
		},
	};
}
