import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { sql } from "drizzle-orm";
import { ConversationOwnershipFenceError } from "./conversation-ownership";
import { reclaimConversationTx } from "./run-store";
import {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
	markRuntimeSandboxTaintedTx,
	recordOrphanSandboxTx,
	updateRuntimeSandboxTx,
} from "./runtime-store";
import {
	conversationRuntime,
	conversations,
	orphanSandboxes,
	runs,
} from "./schema";
import {
	acquireQueuedRunForTest,
	createTestDatabase,
	lapseConversationOwnership,
	seedQueuedRun,
	type TestDb,
} from "./testing";

let tdb: TestDb;

// One PGlite (WASM) instance for the whole file — a per-test instance
// multiplies WASM memory that is not reclaimed promptly and OOMs CI runners.
// Tests are isolated by clearing the tables they touch instead.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(orphanSandboxes);
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conv-1",
		scope: "general",
	});
});

async function tableExists(name: string): Promise<boolean> {
	const result = await tdb.db.execute(
		sql`select 1 from information_schema.tables
			where table_schema = 'public' and table_name = ${name}`,
	);
	return result.rows.length > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
	const result = await tdb.db.execute(
		sql`select 1 from information_schema.columns
			where table_schema = 'public'
				and table_name = ${table} and column_name = ${column}`,
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

	it("drops the snapshot columns from conversation_runtime", async () => {
		// ADR-0007: workspace persistence is the paused sandbox itself; the
		// snapshot checkpoint layer (and its columns) is removed outright.
		expect(await columnExists("conversation_runtime", "sandbox_id")).toBe(true);
		expect(
			await columnExists("conversation_runtime", "latest_snapshot_id"),
		).toBe(false);
		expect(
			await columnExists("conversation_runtime", "previous_snapshot_id"),
		).toBe(false);
		expect(
			await columnExists("conversation_runtime", "workspace_checkpoint_status"),
		).toBe(false);
	});
});

/** The identity every fenced helper is keyed by in these tests. */
const OWNER = {
	userId: "user-1",
	conversationId: "conv-1",
	runId: "run-1",
	workerId: "worker-1",
	epoch: 1,
};

/** Acquire OWNER's Conversation and start its Run. */
async function acquireOwnedRun() {
	await seedQueuedRun(tdb.db, {
		runId: OWNER.runId,
		userId: OWNER.userId,
		conversationId: OWNER.conversationId,
	});
	const acquired = await acquireQueuedRunForTest(tdb.db, {
		workerId: OWNER.workerId,
	});
	if (acquired?.epoch !== OWNER.epoch) {
		throw new Error("test setup failed to acquire the Conversation");
	}
}

/** Lapse the Ownership lease without waiting for its real deadline. */
async function expireOwnership() {
	await lapseConversationOwnership(tdb.db, OWNER);
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
	it("creates an empty runtime row while the caller owns the Conversation", async () => {
		await acquireOwnedRun();

		const runtime = await createConversationRuntimeTx(tdb.db, OWNER);

		expect(runtime).toMatchObject({
			userId: OWNER.userId,
			conversationId: OWNER.conversationId,
			sandboxId: null,
			sandboxTainted: false,
			agentSessionId: null,
		});
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ sandboxId: null });
	});

	it("returns the existing row when the runtime row was already created", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);

		const again = await createConversationRuntimeTx(tdb.db, OWNER);

		expect(again).toMatchObject({
			userId: OWNER.userId,
			conversationId: OWNER.conversationId,
		});
	});

	it("rejects creation after the Ownership lease lapses", async () => {
		await acquireOwnedRun();
		await expireOwnership();

		await expect(
			createConversationRuntimeTx(tdb.db, OWNER),
		).rejects.toBeInstanceOf(ConversationOwnershipFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toBeNull();
	});

	it("rejects creation under a stale Ownership epoch", async () => {
		await acquireOwnedRun();

		await expect(
			createConversationRuntimeTx(tdb.db, { ...OWNER, epoch: OWNER.epoch + 1 }),
		).rejects.toBeInstanceOf(ConversationOwnershipFenceError);
	});
});

describe("updateRuntimeSandboxTx", () => {
	it("stores the current sandbox id while the Conversation is owned", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);

		const runtime = await updateRuntimeSandboxTx(tdb.db, {
			...OWNER,
			sandboxId: "sbx-1",
		});

		expect(runtime.sandboxId).toBe("sbx-1");
		expect(runtime.sandboxTainted).toBe(false);
	});

	it("clears the sandbox pointer with null", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-1" });

		const runtime = await updateRuntimeSandboxTx(tdb.db, {
			...OWNER,
			sandboxId: null,
		});

		expect(runtime.sandboxId).toBeNull();
	});

	it("rejects the update after the Ownership lease lapses", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await expireOwnership();

		await expect(
			updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-stale" }),
		).rejects.toBeInstanceOf(ConversationOwnershipFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ sandboxId: null });
	});

	it("rejects a stale Ownership epoch even while the successor's lease is live", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await tdb.db.update(conversations).set({
			epoch: OWNER.epoch + 1,
			ownerWorkerId: "worker-2",
			ownerUntil: new Date(Date.now() + 60_000),
		});

		await expect(
			updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-stale" }),
		).rejects.toBeInstanceOf(ConversationOwnershipFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ sandboxId: null });
	});

	it("rejects the update after Reclamation terminalizes the Run", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-1" });
		await lapseConversationOwnership(tdb.db, OWNER);
		await reclaimConversationTx(tdb.db);

		await expect(
			updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-2" }),
		).rejects.toBeInstanceOf(ConversationOwnershipFenceError);
		expect(
			await loadConversationRuntimeTx(tdb.db, {
				userId: OWNER.userId,
				conversationId: OWNER.conversationId,
			}),
		).toMatchObject({ sandboxId: "sbx-1" });
	});
});

describe("markRuntimeSandboxTaintedTx", () => {
	it("taints the sandbox while keeping its pointer for cleanup", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-1" });

		const runtime = await markRuntimeSandboxTaintedTx(tdb.db, OWNER);

		expect(runtime).toMatchObject({ sandboxId: "sbx-1", sandboxTainted: true });
	});

	it("is reset when a replacement sandbox id is stored", async () => {
		await acquireOwnedRun();
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

	it("rejects the taint mark after the Ownership lease lapses", async () => {
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await expireOwnership();

		await expect(
			markRuntimeSandboxTaintedTx(tdb.db, OWNER),
		).rejects.toBeInstanceOf(ConversationOwnershipFenceError);
	});
});

describe("recordOrphanSandboxTx", () => {
	it("records a replacement sandbox after the fenced update failed", async () => {
		// The issue's recovery sequence: worker created a replacement sandbox,
		// lost Conversation ownership before the fenced pointer update, and its kill of
		// the replacement could not be confirmed — the ledger insert must
		// succeed precisely because Ownership is already gone.
		await acquireOwnedRun();
		await createConversationRuntimeTx(tdb.db, OWNER);
		await expireOwnership();
		await expect(
			updateRuntimeSandboxTx(tdb.db, { ...OWNER, sandboxId: "sbx-orphan" }),
		).rejects.toBeInstanceOf(ConversationOwnershipFenceError);

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
