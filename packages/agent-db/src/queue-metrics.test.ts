import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { readRunQueueMetrics } from "./queue-metrics";
import { claimNextRunTx, createQueuedRunTx } from "./run-store";
import { conversations, runs } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

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
	return await createQueuedRunTx(tdb.db, {
		runId,
		userId: "user-1",
		conversationId,
	});
}

async function claimRun(
	runId: string,
	conversationId: string,
	workerId: string,
) {
	await queueRun(runId, conversationId);
	const claimed = await claimNextRunTx(tdb.db, { workerId });
	if (claimed?.runId !== runId) {
		throw new Error(`test setup claimed ${claimed?.runId}, wanted ${runId}`);
	}
	return claimed;
}

describe("readRunQueueMetrics", () => {
	it("returns zero counts for an empty queue", async () => {
		await expect(readRunQueueMetrics(tdb.db)).resolves.toEqual({
			queuedRuns: 0,
			runningRuns: 0,
		});
	});

	it("counts recent queued runs and live claimed runs", async () => {
		await claimRun("run-running-live", "conv-running-live", "worker-1");
		await claimRun("run-interrupt-live", "conv-interrupt-live", "worker-2");
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-interrupt-live"));

		await claimRun("run-running-expired", "conv-running-expired", "worker-3");
		await tdb.db
			.update(runs)
			.set({ lockedUntil: sql`now() - interval '1 second'` })
			.where(eq(runs.runId, "run-running-expired"));

		await queueRun("run-queued-1", "conv-queued-1");
		await queueRun("run-queued-2", "conv-queued-2");

		await queueRun("run-queued-old", "conv-queued-old");
		await tdb.db
			.update(runs)
			.set({ createdAt: sql`now() - interval '2 days'` })
			.where(eq(runs.runId, "run-queued-old"));

		await queueRun("run-done", "conv-done");
		await tdb.db
			.update(runs)
			.set({ status: "done", terminalAt: sql`now()` })
			.where(eq(runs.runId, "run-done"));

		await expect(readRunQueueMetrics(tdb.db)).resolves.toEqual({
			queuedRuns: 2,
			runningRuns: 2,
		});
	});
});
