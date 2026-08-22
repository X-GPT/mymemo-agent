import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
	type ConversationOwner,
	liveConversationOwnershipExists,
	releaseConversationTx,
	renewConversationLeaseTx,
} from "./conversation-ownership";
import { reclaimConversationTx } from "./run-store";
import { conversations, runs } from "./schema";
import {
	acquireQueuedRunForTest,
	createTestDatabase,
	lapseConversationOwnership,
	seedQueuedRun,
	type TestDb,
} from "./testing";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(runs);
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conv-1",
		scope: "general",
		executionRuntime: "agentcore",
	});
});

async function acquire(runId: string, workerId: string) {
	await seedQueuedRun(tdb.db, {
		runId,
		userId: "user-1",
		conversationId: "conv-1",
	});
	const owner = await acquireQueuedRunForTest(tdb.db, { runId, workerId });
	if (!owner) throw new Error(`expected ${runId} to be acquired`);
	return owner;
}

async function lapse(): Promise<void> {
	await lapseConversationOwnership(tdb.db, {
		userId: "user-1",
		conversationId: "conv-1",
	});
}

async function readOwnership() {
	const [row] = await tdb.db
		.select({
			ownerWorkerId: conversations.ownerWorkerId,
			ownerUntil: conversations.ownerUntil,
			epoch: conversations.epoch,
		})
		.from(conversations)
		.where(eq(conversations.conversationId, "conv-1"));
	if (!row) throw new Error("Conversation vanished");
	return row;
}

async function fenceAdmits(
	owner: ConversationOwner,
	runId: string,
): Promise<boolean> {
	const rows = await tdb.db
		.select({ runId: runs.runId })
		.from(runs)
		.where(and(eq(runs.runId, runId), liveConversationOwnershipExists(owner)));
	return rows.length > 0;
}

describe("AgentCore Conversation Ownership", () => {
	it("releases an exact acquisition", async () => {
		const owner = await acquire("run-1", "runtime-1");

		expect(await releaseConversationTx(tdb.db, owner)).toBe(true);
		expect(await readOwnership()).toMatchObject({
			ownerWorkerId: null,
			ownerUntil: null,
			epoch: owner.epoch,
		});
	});

	it("cannot release a successor's acquisition", async () => {
		const superseded = await acquire("run-1", "runtime-1");
		await lapse();
		await reclaimConversationTx(tdb.db);
		const successor = await acquire("run-2", "runtime-2");

		expect(await releaseConversationTx(tdb.db, superseded)).toBe(false);
		expect(await readOwnership()).toMatchObject({
			ownerWorkerId: "runtime-2",
			epoch: successor.epoch,
		});
	});

	it("renews a live acquisition", async () => {
		const owner = await acquire("run-1", "runtime-1");
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, "conv-1"));

		const renewed = await renewConversationLeaseTx(tdb.db, owner);

		expect(renewed?.getTime()).toBeGreaterThan(Date.now() + 30_000);
	});

	it("does not renew a lapsed acquisition", async () => {
		const owner = await acquire("run-1", "runtime-1");
		await lapse();

		expect(await renewConversationLeaseTx(tdb.db, owner)).toBe(null);
	});

	it("fences lapsed, superseded, and released acquisitions", async () => {
		const lapsed = await acquire("run-1", "runtime-1");
		expect(await fenceAdmits(lapsed, "run-1")).toBe(true);
		await lapse();
		expect(await fenceAdmits(lapsed, "run-1")).toBe(false);

		await reclaimConversationTx(tdb.db);
		const successor = await acquire("run-2", "runtime-2");
		expect(await fenceAdmits(lapsed, "run-1")).toBe(false);
		expect(await fenceAdmits(successor, "run-2")).toBe(true);
		await releaseConversationTx(tdb.db, successor);
		expect(await fenceAdmits(successor, "run-2")).toBe(false);
	});
});
