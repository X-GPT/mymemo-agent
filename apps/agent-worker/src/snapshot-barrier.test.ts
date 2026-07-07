import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { claimNextRunTx, createQueuedRunTx } from "@mymemo/agent-db/run-store";
import {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
	markRuntimeSandboxTaintedTx,
	type RunOwnershipRef,
	updateRuntimeSandboxTx,
} from "@mymemo/agent-db/runtime-store";
import { conversationRuntime, runs } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "./logger";
import {
	runSnapshotBarrier,
	type SnapshotSandbox,
	type TurnResult,
} from "./snapshot-barrier";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(runs);
	await tdb.db.delete(conversationRuntime);
});

const OWNER: RunOwnershipRef = {
	userId: "user-1",
	conversationId: "conv-1",
	runId: "run-1",
	workerId: "worker-1",
};

/** Claim OWNER's run so `worker-1` holds live ownership, then stand up its
 * runtime row with a stored sandbox pointer — the state a real turn reaches
 * before the barrier runs. */
async function setupOwnedRuntime(sandboxId = "sbx-1") {
	await createQueuedRunTx(tdb.db, {
		runId: OWNER.runId,
		userId: OWNER.userId,
		conversationId: OWNER.conversationId,
	});
	const claimed = await claimNextRunTx(tdb.db, { workerId: OWNER.workerId });
	if (claimed?.runId !== OWNER.runId) throw new Error("setup failed to claim");
	await createConversationRuntimeTx(tdb.db, OWNER);
	await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId });
}

async function expireOwnership() {
	await tdb.db
		.update(runs)
		.set({ lockedUntil: sql`now() - interval '1 second'` })
		.where(eq(runs.runId, OWNER.runId));
}

async function readRuntime() {
	return loadConversationRuntimeTx(tdb.db, {
		userId: OWNER.userId,
		conversationId: OWNER.conversationId,
	});
}

/** A snapshot seam that counts calls; `impl` defaults to returning a fixed id. */
function countingSandbox(impl?: () => Promise<string>) {
	const state = { calls: 0 };
	const sandbox: SnapshotSandbox = {
		async createSnapshot() {
			state.calls++;
			return impl ? await impl() : "snap-1";
		},
	};
	return { sandbox, state };
}

function turn(over: Partial<TurnResult>): TurnResult {
	return { workspaceDirty: false, sandbox: null, ...over };
}

describe("runSnapshotBarrier", () => {
	it("completes a clean workspace without taking a snapshot", async () => {
		await setupOwnedRuntime();
		const { sandbox, state } = countingSandbox();

		const decision = await runSnapshotBarrier({
			db: tdb.db,
			owner: OWNER,
			turnResult: turn({ workspaceDirty: false, sandbox }),
			logger: silentLogger,
		});

		expect(decision).toEqual({ terminal: "done" });
		expect(state.calls).toBe(0);
		expect(await readRuntime()).toMatchObject({
			latestSnapshotId: null,
			workspaceCheckpointStatus: "clean",
		});
	});

	it("completes with done when the turn created no sandbox", async () => {
		await setupOwnedRuntime();

		const decision = await runSnapshotBarrier({
			db: tdb.db,
			owner: OWNER,
			turnResult: turn({ workspaceDirty: true, sandbox: null }),
			logger: silentLogger,
		});

		expect(decision).toEqual({ terminal: "done" });
	});

	it("snapshots a dirty workspace exactly once and records it clean", async () => {
		await setupOwnedRuntime();
		const { sandbox, state } = countingSandbox(async () => "snap-42");

		const decision = await runSnapshotBarrier({
			db: tdb.db,
			owner: OWNER,
			turnResult: turn({ workspaceDirty: true, sandbox }),
			logger: silentLogger,
		});

		expect(decision).toEqual({ terminal: "done" });
		expect(state.calls).toBe(1);
		expect(await readRuntime()).toMatchObject({
			latestSnapshotId: "snap-42",
			workspaceCheckpointStatus: "clean",
		});
	});

	it("terminalizes as error and marks dirty_uncheckpointed when the snapshot fails", async () => {
		await setupOwnedRuntime();
		const { sandbox, state } = countingSandbox(async () => {
			throw new Error("e2b snapshot exploded");
		});

		const decision = await runSnapshotBarrier({
			db: tdb.db,
			owner: OWNER,
			turnResult: turn({ workspaceDirty: true, sandbox }),
			logger: silentLogger,
		});

		expect(decision).toMatchObject({ terminal: "error" });
		expect(state.calls).toBe(1);
		expect(await readRuntime()).toMatchObject({
			latestSnapshotId: null,
			workspaceCheckpointStatus: "dirty_uncheckpointed",
		});
	});

	it("abandons the run without done when ownership is lost while persisting the snapshot", async () => {
		await setupOwnedRuntime();
		// The snapshot itself succeeds, but the lock lapses during it — so the
		// fenced metadata write rejects and the run must not report done.
		const { sandbox } = countingSandbox(async () => {
			await expireOwnership();
			return "snap-late";
		});

		const decision = await runSnapshotBarrier({
			db: tdb.db,
			owner: OWNER,
			turnResult: turn({ workspaceDirty: true, sandbox }),
			logger: silentLogger,
		});

		expect(decision).toMatchObject({ abandon: true });
		// Nothing was persisted: the last-good checkpoint pointer is untouched.
		expect(await readRuntime()).toMatchObject({ latestSnapshotId: null });
	});

	it("refuses to snapshot a tainted sandbox and terminalizes as error", async () => {
		await setupOwnedRuntime();
		await markRuntimeSandboxTaintedTx(tdb.db, OWNER);
		const { sandbox, state } = countingSandbox();

		const decision = await runSnapshotBarrier({
			db: tdb.db,
			owner: OWNER,
			turnResult: turn({ workspaceDirty: true, sandbox }),
			logger: silentLogger,
		});

		expect(decision).toMatchObject({ terminal: "error" });
		expect(state.calls).toBe(0);
	});

	it("taints the sandbox and errors when a managed command is still running", async () => {
		await setupOwnedRuntime();
		const { sandbox, state } = countingSandbox();

		const decision = await runSnapshotBarrier({
			db: tdb.db,
			owner: OWNER,
			turnResult: turn({
				workspaceDirty: false,
				sandbox,
				managedCommandRunning: true,
			}),
			logger: silentLogger,
		});

		expect(decision).toMatchObject({ terminal: "error" });
		expect(state.calls).toBe(0);
		expect(await readRuntime()).toMatchObject({ sandboxTainted: true });
	});
});
