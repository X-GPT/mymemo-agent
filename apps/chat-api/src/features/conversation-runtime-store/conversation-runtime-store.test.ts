import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { runs } from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import {
	claimNextRunTx,
	createQueuedRunTx,
	markStaleRunsTx,
	RunFenceError,
} from "@/features/run-store";
import {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
	markRuntimeCheckpointStatusTx,
	markRuntimeSandboxTaintedTx,
	recordOrphanSandboxTx,
	recordRuntimeSnapshotTx,
	updateRuntimeSandboxTx,
} from "./conversation-runtime-store";

let tdb: TestDb;

beforeEach(async () => {
	tdb = await createTestDatabase();
});

afterEach(async () => {
	await tdb.close();
});

async function tableExists(name: string): Promise<boolean> {
	const result = await tdb.db.execute(
		sql`select 1 from information_schema.tables
			where table_schema = 'public' and table_name = ${name}`,
	);
	return result.rows.length > 0;
}

describe("migration", () => {
	it("creates conversation_runtime and orphan_sandboxes and drops sandbox_leases", async () => {
		// ADR-0002: the prototype path's lease authority dies in the same
		// migration that creates the runtime metadata that replaces it.
		expect(await tableExists("conversation_runtime")).toBe(true);
		expect(await tableExists("orphan_sandboxes")).toBe(true);
		expect(await tableExists("sandbox_leases")).toBe(false);
	});
});

/** The identity every fenced helper is keyed by in these tests. */
const OWNER = {
	userId: "user-1",
	conversationId: "conv-1",
	runId: "run-1",
	workerId: "worker-1",
};

/** Queue and claim OWNER's run so `worker-1` holds live run ownership. */
async function claimOwnedRun() {
	await createQueuedRunTx(tdb.db, {
		runId: OWNER.runId,
		userId: OWNER.userId,
		conversationId: OWNER.conversationId,
	});
	const claimed = await claimNextRunTx(tdb.db, { workerId: OWNER.workerId });
	if (claimed?.runId !== OWNER.runId) {
		throw new Error("test setup failed to claim the owned run");
	}
}

/** Expire the owner's lock so the run is ownership-lost (stale). */
async function expireOwnership() {
	await tdb.db
		.update(runs)
		.set({ lockedUntil: sql`now() - interval '1 second'` })
		.where(eq(runs.runId, OWNER.runId));
}

describe("loadConversationRuntimeTx", () => {
	it("returns null when no runtime row exists", async () => {
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toBeNull();
	});
});

describe("createConversationRuntimeTx", () => {
	it("creates an empty runtime row when the caller owns the active run", async () => {
		await claimOwnedRun();

		const runtime = await createConversationRuntimeTx(tdb.db, OWNER);

		expect(runtime).toMatchObject({
			userId: OWNER.userId,
			conversationId: OWNER.conversationId,
			sandboxId: null,
			sandboxTainted: false,
			latestSnapshotId: null,
			previousSnapshotId: null,
			workspaceCheckpointStatus: "clean",
		});
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ sandboxId: null });
	});

	it("returns the existing row when the runtime row was already created", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);

		const again = await createConversationRuntimeTx(tdb.db, OWNER);

		expect(again).toMatchObject({
			userId: OWNER.userId,
			conversationId: OWNER.conversationId,
		});
	});

	it("rejects creation after run ownership is lost", async () => {
		await claimOwnedRun();
		await expireOwnership();

		await expect(
			createConversationRuntimeTx(tdb.db, OWNER),
		).rejects.toBeInstanceOf(RunFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toBeNull();
	});

	it("rejects creation by a worker that does not hold the run", async () => {
		await claimOwnedRun();

		await expect(
			createConversationRuntimeTx(tdb.db, { ...OWNER, workerId: "worker-2" }),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});

describe("updateRuntimeSandboxTx", () => {
	it("stores the current sandbox id while the run is owned", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);

		const runtime = await updateRuntimeSandboxTx(tdb.db, {
			...OWNER,
			sandboxId: "sbx-1",
		});

		expect(runtime.sandboxId).toBe("sbx-1");
		expect(runtime.sandboxTainted).toBe(false);
	});

	it("clears the sandbox pointer with null", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-1" });

		const runtime = await updateRuntimeSandboxTx(tdb.db, {
			...OWNER,
			sandboxId: null,
		});

		expect(runtime.sandboxId).toBeNull();
	});

	it("rejects the update after run ownership is lost", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await expireOwnership();

		await expect(
			updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-stale" }),
		).rejects.toBeInstanceOf(RunFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ sandboxId: null });
	});

	it("rejects the update after stale-run recovery terminalizes the run", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-1" });
		await expireOwnership();
		await markStaleRunsTx(tdb.db);

		await expect(
			updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-2" }),
		).rejects.toBeInstanceOf(RunFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ sandboxId: "sbx-1" });
	});
});

describe("recordRuntimeSnapshotTx", () => {
	it("rotates latest to previous and marks the workspace clean", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);

		const first = await recordRuntimeSnapshotTx(tdb.db, {
			...OWNER,
			snapshotId: "snap-1",
		});
		expect(first).toMatchObject({
			latestSnapshotId: "snap-1",
			previousSnapshotId: null,
			workspaceCheckpointStatus: "clean",
		});

		const second = await recordRuntimeSnapshotTx(tdb.db, {
			...OWNER,
			snapshotId: "snap-2",
		});
		expect(second).toMatchObject({
			latestSnapshotId: "snap-2",
			previousSnapshotId: "snap-1",
			workspaceCheckpointStatus: "clean",
		});
	});

	it("re-recording the same snapshot id keeps the rollback pointer", async () => {
		// A retried checkpoint (or E2B's repeating `templateId:tag` ids, per the
		// spike) must not rotate latest into previous — that would leave both
		// pointers equal and orphan the real rollback snapshot for cleanup.
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await recordRuntimeSnapshotTx(tdb.db, { ...OWNER, snapshotId: "snap-1" });
		await recordRuntimeSnapshotTx(tdb.db, { ...OWNER, snapshotId: "snap-2" });

		const retried = await recordRuntimeSnapshotTx(tdb.db, {
			...OWNER,
			snapshotId: "snap-2",
		});

		expect(retried).toMatchObject({
			latestSnapshotId: "snap-2",
			previousSnapshotId: "snap-1",
			workspaceCheckpointStatus: "clean",
		});
	});

	it("clears a dirty_uncheckpointed mark once a checkpoint succeeds", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await markRuntimeCheckpointStatusTx(tdb.db, {
			...OWNER,
			status: "dirty_uncheckpointed",
		});

		const runtime = await recordRuntimeSnapshotTx(tdb.db, {
			...OWNER,
			snapshotId: "snap-1",
		});

		expect(runtime.workspaceCheckpointStatus).toBe("clean");
	});

	it("rejects the snapshot record after run ownership is lost", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await recordRuntimeSnapshotTx(tdb.db, { ...OWNER, snapshotId: "snap-1" });
		await expireOwnership();

		await expect(
			recordRuntimeSnapshotTx(tdb.db, { ...OWNER, snapshotId: "snap-2" }),
		).rejects.toBeInstanceOf(RunFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ latestSnapshotId: "snap-1", previousSnapshotId: null });
	});
});

describe("markRuntimeCheckpointStatusTx", () => {
	it("marks dirty_uncheckpointed without touching the snapshot ids", async () => {
		// Acceptance: checkpoint failure leaves the latest snapshot unchanged —
		// the last successful checkpoint stays the recovery source of truth.
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await recordRuntimeSnapshotTx(tdb.db, { ...OWNER, snapshotId: "snap-1" });
		await recordRuntimeSnapshotTx(tdb.db, { ...OWNER, snapshotId: "snap-2" });

		const runtime = await markRuntimeCheckpointStatusTx(tdb.db, {
			...OWNER,
			status: "dirty_uncheckpointed",
		});

		expect(runtime).toMatchObject({
			workspaceCheckpointStatus: "dirty_uncheckpointed",
			latestSnapshotId: "snap-2",
			previousSnapshotId: "snap-1",
		});
	});

	it("rejects the mark after run ownership is lost", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await expireOwnership();

		await expect(
			markRuntimeCheckpointStatusTx(tdb.db, {
				...OWNER,
				status: "dirty_uncheckpointed",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});

describe("markRuntimeSandboxTaintedTx", () => {
	it("taints the sandbox while keeping its pointer for cleanup", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-1" });

		const runtime = await markRuntimeSandboxTaintedTx(tdb.db, OWNER);

		expect(runtime).toMatchObject({ sandboxId: "sbx-1", sandboxTainted: true });
	});

	it("is reset when a replacement sandbox id is stored", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-1" });
		await markRuntimeSandboxTaintedTx(tdb.db, OWNER);

		const runtime = await updateRuntimeSandboxTx(tdb.db, {
			...OWNER,
			sandboxId: "sbx-2",
		});

		expect(runtime).toMatchObject({
			sandboxId: "sbx-2",
			sandboxTainted: false,
		});
	});

	it("rejects the taint mark after run ownership is lost", async () => {
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await expireOwnership();

		await expect(
			markRuntimeSandboxTaintedTx(tdb.db, OWNER),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});

describe("recordOrphanSandboxTx", () => {
	it("records a replacement sandbox after the fenced update failed", async () => {
		// The issue's recovery sequence: worker created a replacement sandbox,
		// lost run ownership before the fenced pointer update, and its kill of
		// the replacement could not be confirmed — the ledger insert must
		// succeed precisely because ownership is already gone.
		await claimOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await expireOwnership();
		await expect(
			updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-orphan" }),
		).rejects.toBeInstanceOf(RunFenceError);

		const orphan = await recordOrphanSandboxTx(tdb.db, {
			sandboxId: "sbx-orphan",
			userId: OWNER.userId,
			conversationId: OWNER.conversationId,
			runId: OWNER.runId,
			createdByWorkerId: OWNER.workerId,
			reason: "ownership lost before fenced sandbox update; kill unconfirmed",
		});

		expect(orphan).toMatchObject({
			sandboxId: "sbx-orphan",
			runId: OWNER.runId,
			createdByWorkerId: OWNER.workerId,
		});
	});

	it("is idempotent for the same sandbox id", async () => {
		const input = {
			sandboxId: "sbx-orphan",
			userId: OWNER.userId,
			conversationId: OWNER.conversationId,
			runId: OWNER.runId,
			createdByWorkerId: OWNER.workerId,
			reason: "kill unconfirmed",
		};

		const first = await recordOrphanSandboxTx(tdb.db, input);
		const second = await recordOrphanSandboxTx(tdb.db, {
			...input,
			reason: "retried recording",
		});

		expect(second).toEqual(first);
	});
});
