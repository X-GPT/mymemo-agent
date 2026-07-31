import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { claimConversationTx } from "./conversation-ownership";
import { readConversationQueueMetrics } from "./queue-metrics";
import { conversations, runs } from "./schema";
import {
	createTestDatabase,
	lapseConversationLease,
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
});

async function queueRun(runId: string, conversationId: string) {
	await tdb.db
		.insert(conversations)
		.values({ userId: "user-1", conversationId, scope: "general" })
		.onConflictDoNothing();
	return await seedQueuedRun(tdb.db, {
		runId,
		userId: "user-1",
		conversationId,
	});
}

async function claimConversation(conversationId: string, workerId: string) {
	const claimed = await claimConversationTx(tdb.db, { workerId });
	if (claimed?.conversationId !== conversationId) {
		throw new Error(
			`test setup claimed ${claimed?.conversationId}, wanted ${conversationId}`,
		);
	}
}

describe("readConversationQueueMetrics", () => {
	it("returns zero counts for an empty queue", async () => {
		await expect(readConversationQueueMetrics(tdb.db)).resolves.toEqual({
			claimableConversations: 0,
			ownedConversations: 0,
		});
	});

	it("counts claimable and owned conversations", async () => {
		// Owned with a live lease: counts as owned, not claimable, even though
		// its queued Run would otherwise qualify. Claimed first because the
		// Claim takes the globally oldest queued Run's Conversation.
		await queueRun("run-owned-live", "conv-owned-live");
		await claimConversation("conv-owned-live", "worker-1");

		// A lapsed lease is claimable again.
		await queueRun("run-owned-lapsed", "conv-owned-lapsed");
		await claimConversation("conv-owned-lapsed", "worker-2");
		await lapseConversationLease(tdb.db, {
			userId: "user-1",
			conversationId: "conv-owned-lapsed",
		});

		// One Conversation with several queued Runs is one claimable unit.
		await queueRun("run-queued-1a", "conv-queued-multi");
		await queueRun("run-queued-1b", "conv-queued-multi");
		await queueRun("run-queued-2", "conv-queued-single");

		// A queued Run outside the recency window does not make its
		// Conversation claimable.
		await queueRun("run-queued-old", "conv-queued-old");
		await tdb.db
			.update(runs)
			.set({ createdAt: sql`now() - interval '2 days'` })
			.where(eq(runs.runId, "run-queued-old"));

		// A terminal Run leaves its Conversation with nothing to claim.
		await queueRun("run-done", "conv-done");
		await tdb.db
			.update(runs)
			.set({ status: "done", terminalAt: sql`now()` })
			.where(eq(runs.runId, "run-done"));

		await expect(readConversationQueueMetrics(tdb.db)).resolves.toEqual({
			claimableConversations: 3,
			ownedConversations: 1,
		});
	});

	it("counts a live-lease conversation as owned even with no queued runs", async () => {
		await queueRun("run-owned-drained", "conv-owned-drained");
		await claimConversation("conv-owned-drained", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "done", terminalAt: sql`now()` })
			.where(eq(runs.runId, "run-owned-drained"));

		await expect(readConversationQueueMetrics(tdb.db)).resolves.toEqual({
			claimableConversations: 0,
			ownedConversations: 1,
		});
	});
});
