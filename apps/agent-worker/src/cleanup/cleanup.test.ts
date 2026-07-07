import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	agentSessions,
	conversationRuntime,
	conversations,
	orphanSandboxes,
} from "@mymemo/agent-db/schema";
import {
	appendAgentSessionEntriesTx,
	loadAgentSessionEntriesTx,
} from "@mymemo/agent-db/session-store";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { and, eq } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import {
	type CleanupPassOptions,
	runCleanupPass,
	type SandboxJanitor,
} from "./cleanup";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

/** Records janitor calls; can be told to fail specific ids to prove retry. */
class FakeJanitor implements SandboxJanitor {
	killed: string[] = [];
	deletedSnapshots: string[] = [];
	killFailIds = new Set<string>();
	deleteFailIds = new Set<string>();

	async killSandbox(sandboxId: string): Promise<void> {
		if (this.killFailIds.has(sandboxId)) throw new Error("E2B kill failed");
		this.killed.push(sandboxId);
	}
	async deleteSnapshot(snapshotId: string): Promise<void> {
		if (this.deleteFailIds.has(snapshotId))
			throw new Error("E2B delete failed");
		this.deletedSnapshots.push(snapshotId);
	}
}

const HOUR_MS = 3_600_000;
const RETENTION_MS = 60_000;

let tdb: TestDb;
let janitor: FakeJanitor;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via truncate, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(() => {
	janitor = new FakeJanitor();
});

afterEach(async () => {
	await tdb.db.delete(orphanSandboxes);
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
	await tdb.db.delete(agentSessions);
});

function pass(overrides?: Partial<CleanupPassOptions>) {
	return runCleanupPass({
		db: tdb.db,
		janitor,
		workerId: "worker-1",
		config: { snapshotRetentionMs: RETENTION_MS },
		logger: silentLogger,
		...overrides,
	});
}

async function insertConversation(userId: string, conversationId: string) {
	await tdb.db
		.insert(conversations)
		.values({ userId, conversationId, scope: "general" });
}

async function insertRuntime(row: {
	userId: string;
	conversationId: string;
	sandboxId?: string | null;
	latestSnapshotId?: string | null;
	previousSnapshotId?: string | null;
	updatedAt?: Date;
}) {
	await tdb.db.insert(conversationRuntime).values(row);
}

async function insertOrphan(sandboxId: string, conversationId = "conv-x") {
	await tdb.db.insert(orphanSandboxes).values({
		sandboxId,
		userId: "user-1",
		conversationId,
		runId: "run-x",
		createdByWorkerId: "worker-old",
		reason: "test",
	});
}

async function orphanIds(): Promise<string[]> {
	const rows = await tdb.db
		.select({ id: orphanSandboxes.sandboxId })
		.from(orphanSandboxes);
	return rows.map((r) => r.id).sort();
}

async function runtimeRow(userId: string, conversationId: string) {
	const [row] = await tdb.db
		.select()
		.from(conversationRuntime)
		.where(
			and(
				eq(conversationRuntime.userId, userId),
				eq(conversationRuntime.conversationId, conversationId),
			),
		);
	return row;
}

describe("orphan sandbox cleanup", () => {
	it("never kills a sandbox still referenced by conversation_runtime", async () => {
		await insertConversation("user-1", "conv-1");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sbx-referenced",
		});
		await insertOrphan("sbx-referenced");

		const summary = await pass();

		expect(janitor.killed).toEqual([]);
		expect(await orphanIds()).toEqual(["sbx-referenced"]);
		expect(summary.orphanSandboxesSkippedReferenced).toBe(1);
		expect(summary.orphanSandboxesKilled).toBe(0);
	});

	it("kills an unreferenced orphan and removes its ledger row", async () => {
		await insertOrphan("sbx-orphan");

		const summary = await pass();

		expect(janitor.killed).toEqual(["sbx-orphan"]);
		expect(await orphanIds()).toEqual([]);
		expect(summary.orphanSandboxesKilled).toBe(1);
	});

	it("retries a failed kill: the ledger row survives, a later pass kills it", async () => {
		await insertOrphan("sbx-flaky");
		janitor.killFailIds.add("sbx-flaky");

		const first = await pass();
		expect(first.orphanSandboxesFailed).toBe(1);
		expect(await orphanIds()).toEqual(["sbx-flaky"]);

		janitor.killFailIds.clear();
		const second = await pass();
		expect(second.orphanSandboxesKilled).toBe(1);
		expect(await orphanIds()).toEqual([]);
	});

	it("isolates a failing orphan from a healthy one in the same pass", async () => {
		await insertOrphan("sbx-bad");
		await insertOrphan("sbx-good");
		janitor.killFailIds.add("sbx-bad");

		const summary = await pass();

		expect(janitor.killed).toEqual(["sbx-good"]);
		expect(await orphanIds()).toEqual(["sbx-bad"]);
		expect(summary.orphanSandboxesKilled).toBe(1);
		expect(summary.orphanSandboxesFailed).toBe(1);
	});
});

describe("unreferenced snapshot retention", () => {
	it("deletes an idle conversation's superseded snapshot, keeping latest", async () => {
		await insertConversation("user-1", "conv-1");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-1",
			latestSnapshotId: "snap-latest",
			previousSnapshotId: "snap-previous",
			updatedAt: new Date(Date.now() - HOUR_MS),
		});

		const summary = await pass();

		expect(janitor.deletedSnapshots).toEqual(["snap-previous"]);
		const row = await runtimeRow("user-1", "conv-1");
		expect(row?.previousSnapshotId).toBeNull();
		expect(row?.latestSnapshotId).toBe("snap-latest");
		expect(summary.snapshotsDeleted).toBe(1);
	});

	it("leaves a recently-active conversation's snapshot until retention elapses", async () => {
		await insertConversation("user-1", "conv-1");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-1",
			latestSnapshotId: "snap-latest",
			previousSnapshotId: "snap-previous",
			// default updatedAt = now(): well within the retention window.
		});

		const summary = await pass();

		expect(janitor.deletedSnapshots).toEqual([]);
		const row = await runtimeRow("user-1", "conv-1");
		expect(row?.previousSnapshotId).toBe("snap-previous");
		expect(summary.snapshotsDeleted).toBe(0);
	});

	it("never deletes a snapshot still referenced as another conversation's latest", async () => {
		await insertConversation("user-1", "conv-idle");
		await insertConversation("user-1", "conv-active");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-idle",
			previousSnapshotId: "snap-shared",
			updatedAt: new Date(Date.now() - HOUR_MS),
		});
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-active",
			latestSnapshotId: "snap-shared",
		});

		await pass();

		expect(janitor.deletedSnapshots).toEqual([]);
		const idle = await runtimeRow("user-1", "conv-idle");
		expect(idle?.previousSnapshotId).toBe("snap-shared");
	});

	it("retries a failed snapshot delete: the pointer survives for a later pass", async () => {
		await insertConversation("user-1", "conv-1");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-1",
			previousSnapshotId: "snap-flaky",
			updatedAt: new Date(Date.now() - HOUR_MS),
		});
		janitor.deleteFailIds.add("snap-flaky");

		const first = await pass();
		expect(first.snapshotsFailed).toBe(1);
		expect((await runtimeRow("user-1", "conv-1"))?.previousSnapshotId).toBe(
			"snap-flaky",
		);

		janitor.deleteFailIds.clear();
		const second = await pass();
		expect(second.snapshotsDeleted).toBe(1);
		expect(
			(await runtimeRow("user-1", "conv-1"))?.previousSnapshotId,
		).toBeNull();
	});
});

describe("deleted-conversation cleanup", () => {
	it("kills sandbox + snapshots then removes the runtime row", async () => {
		// No conversations row => the conversation was deleted.
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-gone",
			sandboxId: "sbx-gone",
			latestSnapshotId: "snap-latest",
			previousSnapshotId: "snap-previous",
		});

		const summary = await pass();

		expect(janitor.killed).toEqual(["sbx-gone"]);
		expect(janitor.deletedSnapshots.sort()).toEqual([
			"snap-latest",
			"snap-previous",
		]);
		expect(await runtimeRow("user-1", "conv-gone")).toBeUndefined();
		expect(summary.deletedRuntimesRemoved).toBe(1);
	});

	it("deletes the deleted conversation's transcripts and keeps a surviving conversation's", async () => {
		// A deleted conversation (no `conversations` row) with a stored transcript.
		await insertRuntime({ userId: "user-1", conversationId: "conv-gone" });
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ conversationId: "conv-gone", projectKey: "p", sessionId: "sess-gone" },
			[{ type: "user", uuid: "a" }],
		);
		// A surviving conversation whose transcript must be untouched.
		await insertConversation("user-1", "conv-live");
		await insertRuntime({ userId: "user-1", conversationId: "conv-live" });
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ conversationId: "conv-live", projectKey: "p", sessionId: "sess-live" },
			[{ type: "user", uuid: "b" }],
		);

		await pass();

		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				conversationId: "conv-gone",
				projectKey: "p",
				sessionId: "sess-gone",
			}),
		).toBeNull();
		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				conversationId: "conv-live",
				projectKey: "p",
				sessionId: "sess-live",
			}),
		).toHaveLength(1);
	});

	it("records an orphan and still clears the pointer when the kill fails", async () => {
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-gone",
			sandboxId: "sbx-stuck",
		});
		janitor.killFailIds.add("sbx-stuck");

		const summary = await pass();

		// Kill failed -> retry state recorded in the orphan ledger...
		expect(await orphanIds()).toEqual(["sbx-stuck"]);
		// ...so the runtime pointer may be cleared.
		expect(await runtimeRow("user-1", "conv-gone")).toBeUndefined();
		expect(summary.deletedRuntimesRemoved).toBe(1);
	});

	it("retains the runtime row when a snapshot delete fails", async () => {
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-gone",
			sandboxId: "sbx-gone",
			latestSnapshotId: "snap-stuck",
		});
		janitor.deleteFailIds.add("snap-stuck");

		const summary = await pass();

		expect(janitor.killed).toEqual(["sbx-gone"]);
		expect(await runtimeRow("user-1", "conv-gone")).toBeDefined();
		expect(summary.deletedRuntimesRetained).toBe(1);
		expect(summary.deletedRuntimesRemoved).toBe(0);
	});

	it("leaves runtime rows of still-existing conversations untouched", async () => {
		await insertConversation("user-1", "conv-live");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-live",
			sandboxId: "sbx-live",
			latestSnapshotId: "snap-live",
		});

		const summary = await pass();

		expect(janitor.killed).toEqual([]);
		expect(janitor.deletedSnapshots).toEqual([]);
		expect(await runtimeRow("user-1", "conv-live")).toBeDefined();
		expect(summary.deletedRuntimesRemoved).toBe(0);
	});

	it("does not delete a snapshot a surviving conversation still references", async () => {
		await insertConversation("user-1", "conv-live");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-live",
			latestSnapshotId: "snap-shared",
		});
		// Deleted conversation shares the snapshot id (repeating templateId:tag).
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-gone",
			latestSnapshotId: "snap-shared",
		});

		await pass();

		expect(janitor.deletedSnapshots).toEqual([]);
		// The deleted row is still removed; the live conversation keeps the snapshot.
		expect(await runtimeRow("user-1", "conv-gone")).toBeUndefined();
		expect(await runtimeRow("user-1", "conv-live")).toBeDefined();
	});
});
