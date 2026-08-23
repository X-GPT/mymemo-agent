import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
	acquireAgentCoreDispatchTx,
	claimAgentCoreDispatchesTx,
	confirmAgentCoreDispatchPublishedTx,
	loadAgentCoreDispatchRunStatus,
	loadOldestUnpublishedAgentCoreDispatchAdmittedAt,
	recordAgentCoreDispatchInTx,
} from "./agentcore-dispatch";
import { admitQueuedRunInTx } from "./run-store";
import {
	agentCoreDispatchOutbox,
	conversations,
	runEvents,
	runs,
} from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

const admittedAt = new Date("2026-08-14T16:00:00.000Z");
const exact = {
	userId: "agentcore-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "0198b5a2-1c70-7be1-8e52-acdeab984501",
	messageId: "0198b5a2-2c70-7855-b090-acdeab984502",
} as const;
const dispatch = {
	schemaVersion: 2 as const,
	userId: exact.userId,
	conversationId: exact.conversationId,
	runId: exact.runId,
	runtimeSessionId: exact.conversationId,
	admittedAt,
};

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(agentCoreDispatchOutbox);
	await tdb.db.delete(conversations);
});

async function insertConversation(database = tdb): Promise<void> {
	await database.db.insert(conversations).values({
		userId: exact.userId,
		conversationId: exact.conversationId,
		scope: "general",
	});
}

async function admitRunWithDispatch(database = tdb): Promise<void> {
	await insertConversation(database);
	await database.db.transaction(async (tx) => {
		await tx
			.select({ conversationId: conversations.conversationId })
			.from(conversations)
			.where(eq(conversations.conversationId, exact.conversationId))
			.for("update");
		const admission = await admitQueuedRunInTx(tx, {
			runId: exact.runId,
			userId: exact.userId,
			conversationId: exact.conversationId,
			messageId: exact.messageId,
			text: "Run the admitted AgentCore turn.",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
		if (admission.outcome !== "created") {
			throw new Error("test Run was not newly admitted");
		}
		await recordAgentCoreDispatchInTx(tx, { ...exact, admittedAt });
	});
}

describe("Run-keyed AgentCore dispatch outbox", () => {
	it("reads the exact dispatched Run status for the consumer pre-check", async () => {
		await admitRunWithDispatch();

		await expect(
			loadAgentCoreDispatchRunStatus(tdb.db, dispatch),
		).resolves.toBe("queued");
		await expect(
			loadAgentCoreDispatchRunStatus(tdb.db, {
				...dispatch,
				userId: "another-user",
			}),
		).resolves.toBeNull();
		await expect(
			loadAgentCoreDispatchRunStatus(tdb.db, {
				...dispatch,
				admittedAt: new Date(admittedAt.getTime() + 1),
			}),
		).resolves.toBeNull();
	});

	it("matches an outbox timestamp after it crosses JavaScript Date precision", async () => {
		await insertConversation();
		await tdb.db.transaction(async (tx) => {
			const admission = await admitQueuedRunInTx(tx, {
				runId: exact.runId,
				userId: exact.userId,
				conversationId: exact.conversationId,
				messageId: exact.messageId,
				text: "Run the admitted AgentCore turn.",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			if (admission.outcome !== "created") {
				throw new Error("test Run was not newly admitted");
			}
			await recordAgentCoreDispatchInTx(tx, exact);
		});
		await tdb.db.execute(sql`
			update ${agentCoreDispatchOutbox}
			set admitted_at = date_trunc('milliseconds', admitted_at) + interval '0.123 milliseconds'
			where run_id = ${exact.runId}
		`);
		const [claimed] = await claimAgentCoreDispatchesTx(tdb.db, {
			publisherId: "publisher-precision",
		});
		if (!claimed) throw new Error("test dispatch was not claimed");
		await tdb.db
			.update(runs)
			.set({ status: "done" })
			.where(eq(runs.runId, exact.runId));

		await expect(loadAgentCoreDispatchRunStatus(tdb.db, claimed)).resolves.toBe(
			"done",
		);
	});

	it("commits admission and one dispatch record together", async () => {
		await admitRunWithDispatch();

		expect(await tdb.db.select().from(runs)).toMatchObject([
			{ runId: exact.runId, status: "queued" },
		]);
		expect(await tdb.db.select().from(runEvents)).toMatchObject([
			{ runId: exact.runId, seq: 1, type: "run_started" },
		]);
		expect(await tdb.db.select().from(agentCoreDispatchOutbox)).toMatchObject([
			{
				runId: exact.runId,
				userId: exact.userId,
				conversationId: exact.conversationId,
				admittedAt,
				publishedAt: null,
				publishAttempts: 0,
			},
		]);
		await expect(
			tdb.db.transaction(async (tx) =>
				recordAgentCoreDispatchInTx(tx, { ...exact, admittedAt }),
			),
		).rejects.toThrow();
	});

	it("claims a strict version-2 envelope keyed by the Run identity", async () => {
		await admitRunWithDispatch();

		await expect(
			claimAgentCoreDispatchesTx(tdb.db, {
				publisherId: "publisher-1",
				now: new Date("2026-08-14T16:01:00.000Z"),
			}),
		).resolves.toEqual([dispatch]);
		expect(await tdb.db.select().from(agentCoreDispatchOutbox)).toMatchObject([
			{
				runId: exact.runId,
				publishClaimedBy: "publisher-1",
				publishClaimUntil: new Date("2026-08-14T16:04:00.000Z"),
				publishAttempts: 1,
			},
		]);
	});

	it("reports the oldest unpublished admission for publisher telemetry", async () => {
		await admitRunWithDispatch();

		await expect(
			loadOldestUnpublishedAgentCoreDispatchAdmittedAt(tdb.db),
		).resolves.toEqual(admittedAt);

		await claimAgentCoreDispatchesTx(tdb.db, {
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});
		await confirmAgentCoreDispatchPublishedTx(tdb.db, {
			runId: exact.runId,
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:10.000Z"),
		});

		await expect(
			loadOldestUnpublishedAgentCoreDispatchAdmittedAt(tdb.db),
		).resolves.toBeNull();
	});

	it("keeps publisher and acquisition queries independent of deprecated replay columns", async () => {
		const compatibilityDb = await createTestDatabase();
		try {
			await admitRunWithDispatch(compatibilityDb);
			await compatibilityDb.db.execute(sql`
				alter table ${agentCoreDispatchOutbox} drop column replay_requested_at
			`);
			await compatibilityDb.db.execute(sql`
				alter table ${agentCoreDispatchOutbox} drop column replay_requested_by
			`);

			const [claimed] = await claimAgentCoreDispatchesTx(compatibilityDb.db, {
				publisherId: "publisher-without-replay-columns",
			});
			if (!claimed) throw new Error("test dispatch was not claimed");

			await expect(
				acquireAgentCoreDispatchTx(compatibilityDb.db, {
					dispatch: claimed,
					workerId: "agentcore-without-replay-columns",
				}),
			).resolves.toMatchObject({ disposition: "acquired" });
		} finally {
			await compatibilityDb.close();
		}
	});
});

describe("acquireAgentCoreDispatchTx", () => {
	it("takes the claimed envelope through exact acquisition in one transaction", async () => {
		await admitRunWithDispatch();
		const [claimed] = await claimAgentCoreDispatchesTx(tdb.db, {
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});
		if (!claimed) throw new Error("dispatch was not claimed");

		await expect(
			acquireAgentCoreDispatchTx(tdb.db, {
				dispatch: claimed,
				workerId: "agentcore-boot/invocation-1",
				now: new Date("2026-08-14T16:01:00.000Z"),
			}),
		).resolves.toEqual({
			disposition: "acquired",
			owner: {
				userId: exact.userId,
				conversationId: exact.conversationId,
				epoch: 1,
			},
			workerId: "agentcore-boot/invocation-1",
		});
		expect(await tdb.db.select().from(runs)).toMatchObject([
			{
				runId: exact.runId,
				status: "running",
				executedByWorkerId: "agentcore-boot/invocation-1",
			},
		]);
	});

	it("returns already_acquired for a live duplicate", async () => {
		await admitRunWithDispatch();
		await acquireAgentCoreDispatchTx(tdb.db, {
			dispatch,
			workerId: "agentcore-boot/invocation-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		await expect(
			acquireAgentCoreDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-boot/invocation-2",
				now: new Date("2026-08-14T16:01:30.000Z"),
			}),
		).resolves.toEqual({
			disposition: "already_acquired",
			owner: {
				userId: exact.userId,
				conversationId: exact.conversationId,
				epoch: 1,
			},
			workerId: "agentcore-boot/invocation-1",
		});
	});

	it("returns terminal for an exact Run that already has an Outcome", async () => {
		await admitRunWithDispatch();
		await tdb.db
			.update(runs)
			.set({ status: "interrupted", terminalAt: admittedAt })
			.where(eq(runs.runId, exact.runId));

		await expect(
			acquireAgentCoreDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-boot/late-invocation",
			}),
		).resolves.toEqual({ disposition: "terminal", status: "interrupted" });
	});

	it("returns temporarily_unavailable for any existing Ownership", async () => {
		await admitRunWithDispatch();
		await tdb.db
			.update(conversations)
			.set({
				ownerWorkerId: "existing-owner",
				ownerUntil: new Date("2026-08-14T15:59:59.000Z"),
			})
			.where(eq(conversations.conversationId, exact.conversationId));

		await expect(
			acquireAgentCoreDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-boot/invocation-2",
				now: new Date("2026-08-14T16:01:00.000Z"),
			}),
		).resolves.toEqual({ disposition: "temporarily_unavailable" });
	});

	it("returns invalid_dispatch for identity or Runtime-session mismatches", async () => {
		await admitRunWithDispatch();

		for (const mismatched of [
			{ ...dispatch, userId: "another-user" },
			{ ...dispatch, runtimeSessionId: "another-runtime-session" },
			{ ...dispatch, admittedAt: new Date(admittedAt.getTime() + 1) },
		]) {
			await expect(
				acquireAgentCoreDispatchTx(tdb.db, {
					dispatch: mismatched,
					workerId: "agentcore-invalid-invocation",
				}),
			).resolves.toEqual({ disposition: "invalid_dispatch" });
		}
	});

	it("refuses a dispatched Run that is not the oldest Active Run", async () => {
		await admitRunWithDispatch();
		await tdb.db.insert(runs).values({
			runId: "older-active-run",
			userId: exact.userId,
			conversationId: exact.conversationId,
			status: "queued",
			createdAt: new Date("2026-08-14T15:00:00.000Z"),
		});

		await expect(
			acquireAgentCoreDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-out-of-order-invocation",
			}),
		).resolves.toEqual({ disposition: "invalid_dispatch" });
		expect(await tdb.db.select().from(runs)).toMatchObject([
			{ runId: exact.runId, status: "queued" },
			{ runId: "older-active-run", status: "queued" },
		]);
	});
});
