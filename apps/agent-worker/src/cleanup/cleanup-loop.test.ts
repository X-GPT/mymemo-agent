import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { orphanSandboxes } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type { WorkerLogger } from "../logger";
import type { AdvisoryLockClient, AdvisoryLockPool } from "./advisory-lock";
import type { SandboxJanitor } from "./cleanup";
import { CleanupLoop } from "./cleanup-loop";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

class FakeJanitor implements SandboxJanitor {
	killed: string[] = [];
	async killSandbox(id: string): Promise<void> {
		this.killed.push(id);
	}
	async deleteSnapshot(): Promise<void> {}
}

/** Grants or withholds the lock; can also fail `connect` to prove isolation. */
class FakePool implements AdvisoryLockPool {
	constructor(
		private readonly locked: boolean,
		private readonly failConnect = false,
	) {}
	async connect(): Promise<AdvisoryLockClient> {
		if (this.failConnect) throw new Error("pool exhausted");
		const locked = this.locked;
		return {
			async query(text: string) {
				return text.includes("pg_try_advisory_lock")
					? { rows: [{ locked }] }
					: { rows: [] };
			},
			release() {},
		};
	}
}

let tdb: TestDb;
let janitor: FakeJanitor;

beforeEach(async () => {
	tdb = await createTestDatabase();
	janitor = new FakeJanitor();
	await tdb.db.insert(orphanSandboxes).values({
		sandboxId: "sbx-orphan",
		userId: "user-1",
		conversationId: "conv-1",
		runId: "run-1",
		createdByWorkerId: "worker-old",
		reason: "test",
	});
});

afterEach(async () => {
	await tdb.close();
});

function buildLoop(pool: AdvisoryLockPool) {
	return new CleanupLoop({
		db: tdb.db,
		pool,
		janitor,
		workerId: "worker-1",
		config: { snapshotRetentionMs: 60_000 },
		intervalMs: 60_000,
		logger: silentLogger,
	});
}

describe("CleanupLoop.runOnce", () => {
	it("runs a pass and returns the summary when it holds the lock", async () => {
		const loop = buildLoop(new FakePool(true));

		const summary = await loop.runOnce();

		expect(summary?.orphanSandboxesKilled).toBe(1);
		expect(janitor.killed).toEqual(["sbx-orphan"]);
	});

	it("skips the pass when another replica holds the lock", async () => {
		const loop = buildLoop(new FakePool(false));

		const summary = await loop.runOnce();

		expect(summary).toBeUndefined();
		expect(janitor.killed).toEqual([]);
		// The orphan is untouched, left for whoever holds the lock.
		const remaining = await tdb.db.select().from(orphanSandboxes);
		expect(remaining).toHaveLength(1);
	});

	it("never throws when acquiring the lock fails", async () => {
		const loop = buildLoop(new FakePool(true, true));

		const summary = await loop.runOnce();

		expect(summary).toBeUndefined();
		expect(janitor.killed).toEqual([]);
	});
});

describe("CleanupLoop start/stop", () => {
	it("does not run before the first interval and stops cleanly", async () => {
		const loop = buildLoop(new FakePool(true));

		loop.start();
		// First attempt is scheduled one interval out, so nothing has run yet.
		expect(janitor.killed).toEqual([]);
		loop.stop();
		expect(janitor.killed).toEqual([]);
	});
});
