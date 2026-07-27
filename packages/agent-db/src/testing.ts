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
 * Always `close()` the returned handle (e.g. in `afterAll`): an unclosed pglite
 * instance leaks resources and makes `bun test` exit non-zero even when every
 * assertion passes.
 */
export interface TestDb {
	db: Database;
	close: () => Promise<void>;
}

// Bun's JSC intermittently traps with `RuntimeError: access to a null
// reference` inside pglite's WASM while a fresh instance boots: initdb
// re-enters the postgres main module through Emscripten's dynamic-linking
// function table and observes a null funcref. It is rare (order of one boot
// per thousand on CI runners), Bun-specific, and unfixed upstream
// (https://github.com/electric-sql/pglite/issues/831), and it has only ever
// been seen during instance creation — never after `waitReady` resolves. So
// creation retries on exactly that trap, on a fresh instance each time;
// deterministic failures (migration SQL errors, missing files) rethrow on the
// first attempt. Capped at one retry so a persistent trap surfaces as a failure
// instead of a long retry loop; the workspace `test` scripts raise bun's
// per-test timeout (which also governs hooks) to 30s, since the first pglite
// boot in a `bun test` process pays the one-time postgres.wasm compile and has
// measured up to ~6.7s on CI runners — past bun's 5s default.
const BOOT_ATTEMPTS = 2;

function isWasmBootTrap(err: unknown): boolean {
	return (
		err instanceof WebAssembly.RuntimeError ||
		(err instanceof Error && err.name === "RuntimeError")
	);
}

async function releaseClient(client: PGlite): Promise<void> {
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
}

async function bootWithMigrations(createClient: () => PGlite): Promise<PGlite> {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (let attempt = 1; ; attempt++) {
		let client: PGlite | undefined;
		try {
			client = createClient();
			await client.waitReady;
			for (const file of files) {
				const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
				for (const stmt of sql.split("--> statement-breakpoint")) {
					if (stmt.trim()) await client.exec(stmt);
				}
			}
			return client;
		} catch (err) {
			if (client) await releaseClient(client).catch(() => {});
			if (!isWasmBootTrap(err) || attempt >= BOOT_ATTEMPTS) throw err;
			// Deliberately loud: keeps the upstream flake's frequency observable
			// in CI logs instead of silently absorbed.
			console.warn(
				`pglite WASM boot trap (attempt ${attempt}/${BOOT_ATTEMPTS}), retrying:`,
				err,
			);
		}
	}
}

export async function createTestDatabase(
	// Seam for the harness's own tests; real callers take the default.
	createClient: () => PGlite = () => new PGlite(),
): Promise<TestDb> {
	const client = await bootWithMigrations(createClient);
	return {
		db: drizzle(client, { schema }) as unknown as Database,
		close: () => releaseClient(client),
	};
}

/** Seed the two owned Runs shared by the package and worker SessionStore fence
 * suites. Callers remain responsible for clearing their tables. */
export async function seedAgentSessionFenceRuns(db: Database): Promise<void> {
	await db.insert(schema.conversations).values([
		{ userId: "user-1", conversationId: "conv-1", scope: "general" },
		{ userId: "user-2", conversationId: "conv-2", scope: "general" },
	]);
	await db.insert(schema.runs).values([
		{
			runId: "run-conv-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
			lockedBy: "worker-1",
			lockedUntil: new Date(Date.now() + 60_000),
		},
		{
			runId: "run-conv-2",
			userId: "user-2",
			conversationId: "conv-2",
			status: "running",
			lockedBy: "worker-1",
			lockedUntil: new Date(Date.now() + 60_000),
		},
	]);
}
