import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDb } from "@/db/testing";
import { runEvents, runs } from "./schema";

async function expectDbWriteToFail(write: () => PromiseLike<unknown>) {
	let failed = false;
	try {
		await write();
	} catch {
		failed = true;
	}
	expect(failed).toBe(true);
}

describe("run queue schema", () => {
	let tdb: TestDb;

	beforeEach(async () => {
		tdb = await createTestDatabase();
	});

	afterEach(async () => {
		await tdb.close();
	});

	it("creates runs with milestone-1 queue defaults", async () => {
		const [run] = await tdb.db
			.insert(runs)
			.values({
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "queued",
			})
			.returning();

		expect(run).toMatchObject({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			lockedBy: null,
			lockedUntil: null,
			heartbeatAt: null,
			cancelRequestedAt: null,
			fencingToken: 0,
			nextEventSeq: 1,
			terminalAt: null,
		});
		expect(run?.createdAt).toBeInstanceOf(Date);
		expect(run?.updatedAt).toBeInstanceOf(Date);
	});

	it("rejects invalid run statuses", async () => {
		await expectDbWriteToFail(() =>
			tdb.db.insert(runs).values({
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "not-a-status",
			}),
		);
	});

	it("enforces one active run per conversation", async () => {
		await tdb.db.insert(runs).values({
			runId: "run-active-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
		});

		await expectDbWriteToFail(() =>
			tdb.db.insert(runs).values({
				runId: "run-active-2",
				userId: "user-1",
				conversationId: "conv-1",
				status: "running",
			}),
		);

		await tdb.db.insert(runs).values({
			runId: "run-terminal",
			userId: "user-1",
			conversationId: "conv-1",
			status: "done",
		});
	});

	it("allows active runs for different conversations", async () => {
		await tdb.db.insert(runs).values([
			{
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "queued",
			},
			{
				runId: "run-2",
				userId: "user-1",
				conversationId: "conv-2",
				status: "queued",
			},
		]);
	});

	it("records ordered run events with visibility hints", async () => {
		await tdb.db.insert(runs).values({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
		});

		await tdb.db.insert(runEvents).values([
			{
				runId: "run-1",
				seq: 1,
				type: "run_started",
				visibility: "internal",
				payload: { workerId: "worker-1" },
			},
			{
				runId: "run-1",
				seq: 2,
				type: "text_delta",
				visibility: "client",
				payload: { text: "hello" },
			},
		]);

		const events = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"))
			.orderBy(runEvents.seq);

		expect(events.map((event) => event.seq)).toEqual([1, 2]);
		expect(events.map((event) => event.visibility)).toEqual([
			"internal",
			"client",
		]);
	});

	it("rejects duplicate event sequence numbers and invalid visibility", async () => {
		await tdb.db.insert(runs).values({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
		});
		await tdb.db.insert(runEvents).values({
			runId: "run-1",
			seq: 1,
			type: "run_started",
			visibility: "internal",
			payload: {},
		});

		await expectDbWriteToFail(() =>
			tdb.db.insert(runEvents).values({
				runId: "run-1",
				seq: 1,
				type: "run_started_again",
				visibility: "internal",
				payload: {},
			}),
		);
		await expectDbWriteToFail(() =>
			tdb.db.insert(runEvents).values({
				runId: "run-1",
				seq: 2,
				type: "bad_visibility",
				visibility: "debug",
				payload: {},
			}),
		);
	});
});
