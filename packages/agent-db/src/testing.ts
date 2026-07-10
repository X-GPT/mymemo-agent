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
			try {
				await client.close();
			} finally {
				// pglite's close() shuts Postgres down but keeps the Emscripten
				// module — and its ~1GB WASM linear memory — referenced via
				// `client.mod`. Test files hold their handle in a module-level
				// `let tdb` that lives for the whole `bun test` process, so each
				// closed-but-referenced instance stays pinned (~465MB, GC-immune)
				// and peak memory climbs one corpse per pglite file until a later
				// `new PGlite()` cannot allocate and fails to initialize — the flaky
				// CI OOM. Dropping `client.mod` unpins the WASM memory even while the
				// handle is referenced; the forced GC then reclaims it deterministically
				// (measured: pinned arrayBuffers 2.3GB -> 0 with the null, unchanged
				// without it). Runs in `finally` so it still fires if close() throws
				// (e.g. a double-close raising "PGlite is closed").
				(client as unknown as { mod?: unknown }).mod = undefined;
				if (typeof Bun !== "undefined") Bun.gc(true);
			}
		},
	};
}
