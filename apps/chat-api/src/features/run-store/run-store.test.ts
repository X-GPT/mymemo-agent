import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDatabase, type TestDb } from "@/db/testing";
import { runEvents, runs } from "@/db/schema";
import {
	appendRunEventTx,
	claimNextRunTx,
	createQueuedRunTx,
	heartbeatRunTx,
	recoverOneStaleRunTx,
	requestRunCancellationTx,
	RUN_EVENT_TYPES,
	transitionRunTerminalTx,
	type ClaimedRun,
} from "./run-store";

const TTL = 60_000;

describe("run-store transaction helpers", () => {
	let tdb: TestDb;

	beforeEach(async () => {
		tdb = await createTestDatabase();
	});

	afterEach(async () => {
		await tdb.close();
	});

	it("createQueuedRunTx inserts a queued run and run_created atomically", async () => {
		const created = await createRun("run-1", "user-1", "conv-1");

		expect(created).toEqual({
			status: "created",
			runId: "run-1",
			runStatus: "queued",
			eventSeq: 1,
		});
		expect(await getRun("run-1")).toMatchObject({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			fencingToken: 0,
			nextEventSeq: 2,
		});
		expect(await getEvents("run-1")).toEqual([
			expect.objectContaining({
				seq: 1,
				type: RUN_EVENT_TYPES.runCreated,
				visibility: "internal",
				payload: {
					userId: "user-1",
					conversationId: "conv-1",
					runId: "run-1",
				},
			}),
		]);
	});

	it("createQueuedRunTx returns an active-run conflict for the unique index", async () => {
		await createRun("run-1", "user-1", "conv-1");

		await expect(
			createQueuedRunTx(tdb.db, {
				runId: "run-2",
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).resolves.toEqual({ status: "active_run_exists" });
	});

	it("createQueuedRunTx does not report duplicate run ids as active-run conflicts", async () => {
		await createRun("run-1", "user-1", "conv-1");

		await expect(
			createQueuedRunTx(tdb.db, {
				runId: "run-1",
				userId: "user-2",
				conversationId: "conv-2",
			}),
		).rejects.toThrow();
	});

	it("claimNextRunTx claims one queued run and appends run_claimed", async () => {
		await createRun("run-1", "user-1", "conv-1");

		const claimed = await claimNextRunTx(tdb.db, {
			workerId: "worker-1",
			ttlMs: TTL,
		});

		expect(claimed).toMatchObject({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			workerId: "worker-1",
			fencingToken: 1,
		});
		expect(claimed?.lockedUntil).toBeInstanceOf(Date);
		expect(await getRun("run-1")).toMatchObject({
			status: "running",
			lockedBy: "worker-1",
			fencingToken: 1,
			nextEventSeq: 3,
		});
		expect(await compactEvents("run-1")).toEqual([
			{
				seq: 1,
				type: RUN_EVENT_TYPES.runCreated,
				visibility: "internal",
				payload: {
					userId: "user-1",
					conversationId: "conv-1",
					runId: "run-1",
				},
			},
			{
				seq: 2,
				type: RUN_EVENT_TYPES.runClaimed,
				visibility: "internal",
				payload: { workerId: "worker-1" },
			},
		]);
	});

	it("claimNextRunTx returns null when no queued run is claimable", async () => {
		expect(
			await claimNextRunTx(tdb.db, { workerId: "worker-1", ttlMs: TTL }),
		).toBeNull();
	});

	it("appendRunEventTx allocates monotonic seq values through next_event_seq", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();

		const first = await appendRunEventTx(tdb.db, {
			mode: { kind: "owner_running", owner: claimed },
			type: "worker_note",
			visibility: "internal",
			payload: { step: 1 },
		});
		const second = await appendRunEventTx(tdb.db, {
			mode: { kind: "owner_running", owner: claimed },
			type: "model_note",
			visibility: "internal",
			payload: { step: 2 },
		});

		expect(first).toEqual({ status: "appended", seq: 3 });
		expect(second).toEqual({ status: "appended", seq: 4 });
		expect((await getRun("run-1"))?.nextEventSeq).toBe(5);
		expect((await getEvents("run-1")).map((event) => event.seq)).toEqual([
			1, 2, 3, 4,
		]);
	});

	it("appendRunEventTx rejects terminal event types", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();

		expect(
			await appendRunEventTx(tdb.db, {
				mode: { kind: "owner_running", owner: claimed },
				type: RUN_EVENT_TYPES.runDone,
				visibility: "client",
				payload: {},
			}),
		).toEqual({ status: "not_appendable" });
		expect((await getRun("run-1"))?.nextEventSeq).toBe(3);
		expect(await compactEvents("run-1")).toHaveLength(2);
	});

	it("heartbeatRunTx succeeds for the matching owner token and fails for wrong owner data", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();

		expect(
			await heartbeatRunTx(tdb.db, { ...claimed, ttlMs: TTL }),
		).toMatchObject({ status: "ok" });
		expect(
			await heartbeatRunTx(tdb.db, {
				...claimed,
				workerId: "worker-2",
				ttlMs: TTL,
			}),
		).toEqual({ status: "lost_ownership" });
		expect(
			await heartbeatRunTx(tdb.db, {
				...claimed,
				fencingToken: claimed.fencingToken + 1,
				ttlMs: TTL,
			}),
		).toEqual({ status: "lost_ownership" });
	});

	it("heartbeatRunTx does not append durable heartbeat events", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();

		await heartbeatRunTx(tdb.db, { ...claimed, ttlMs: TTL });

		expect(await compactEvents("run-1")).toHaveLength(2);
		expect(
			(await compactEvents("run-1")).map((event) => event.type),
		).not.toContain("run_heartbeat");
	});

	it("heartbeatRunTx reports cancellation requests without extending ownership", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		const lockedUntil = (await getRun("run-1"))?.lockedUntil;
		await requestRunCancellationTx(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});

		expect(await heartbeatRunTx(tdb.db, { ...claimed, ttlMs: TTL })).toEqual({
			status: "cancel_requested",
		});
		expect((await getRun("run-1"))?.lockedUntil).toEqual(lockedUntil);
	});

	it("stale owner appends fail after the fencing token changes", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		await tdb.db
			.update(runs)
			.set({ fencingToken: sql`${runs.fencingToken} + 1` })
			.where(eq(runs.runId, claimed.runId));

		expect(
			await appendRunEventTx(tdb.db, {
				mode: { kind: "owner_running", owner: claimed },
				type: "worker_note",
				visibility: "internal",
				payload: {},
			}),
		).toEqual({ status: "not_appendable" });
	});

	it("stale owner appends fail after the lock expires", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		await expireRun(claimed.runId);

		expect(
			await appendRunEventTx(tdb.db, {
				mode: { kind: "owner_running", owner: claimed },
				type: "model_note",
				visibility: "internal",
				payload: {},
			}),
		).toEqual({ status: "not_appendable" });
	});

	it("queued cancellation transitions directly to canceled and appends one run_canceled", async () => {
		await createRun("run-1", "user-1", "conv-1");

		expect(
			await requestRunCancellationTx(tdb.db, {
				userId: "user-1",
				conversationId: "conv-1",
				runId: "run-1",
			}),
		).toEqual({ status: "canceled", eventSeq: 2 });
		expect(await getRun("run-1")).toMatchObject({
			status: "canceled",
			lockedBy: null,
			lockedUntil: null,
		});
		expect(await terminalEvents("run-1")).toEqual([
			{
				seq: 2,
				type: RUN_EVENT_TYPES.runCanceled,
				visibility: "client",
				payload: {},
			},
		]);
	});

	it("running cancellation requests cancellation, keeps ownership, and appends run_cancel_requested", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();

		expect(
			await requestRunCancellationTx(tdb.db, {
				userId: "user-1",
				conversationId: "conv-1",
				runId: "run-1",
				requestedBy: "user",
				reason: "stop",
			}),
		).toEqual({ status: "requested", eventSeq: 3 });
		expect(await getRun("run-1")).toMatchObject({
			status: "cancel_requested",
			lockedBy: claimed.workerId,
			fencingToken: claimed.fencingToken,
		});
		expect((await compactEvents("run-1")).at(-1)).toEqual({
			seq: 3,
			type: RUN_EVENT_TYPES.runCancelRequested,
			visibility: "internal",
			payload: { requestedBy: "user", reason: "stop" },
		});
	});

	it("repeated cancellation does not duplicate terminal or control events", async () => {
		await createRun("run-1", "user-1", "conv-1");
		await claimRun();
		await requestRunCancellationTx(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});

		expect(
			await requestRunCancellationTx(tdb.db, {
				userId: "user-1",
				conversationId: "conv-1",
				runId: "run-1",
			}),
		).toEqual({ status: "requested", eventSeq: null });
		expect(
			(await compactEvents("run-1")).filter(
				(event) => event.type === RUN_EVENT_TYPES.runCancelRequested,
			),
		).toHaveLength(1);
	});

	it("success after cancel_requested loses", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		await requestRunCancellationTx(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});

		expect(
			await transitionRunTerminalTx(tdb.db, {
				...claimed,
				transition: "success",
			}),
		).toEqual({ status: "lost_ownership_or_not_transitionable" });
		expect(await getRun("run-1")).toMatchObject({ status: "cancel_requested" });
	});

	it("terminal transition appends exactly one terminal event", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();

		expect(
			await transitionRunTerminalTx(tdb.db, {
				...claimed,
				transition: "failure",
				message: "Client-safe failure",
			}),
		).toEqual({
			status: "transitioned",
			runStatus: "error",
			eventSeq: 3,
		});
		expect(await getRun("run-1")).toMatchObject({
			status: "error",
			lockedBy: null,
			lockedUntil: null,
		});
		expect(await terminalEvents("run-1")).toEqual([
			{
				seq: 3,
				type: RUN_EVENT_TYPES.runError,
				visibility: "client",
				payload: { message: "Client-safe failure" },
			},
		]);
	});

	it("concurrent or repeated terminalization produces one terminal event", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();

		expect(
			await transitionRunTerminalTx(tdb.db, {
				...claimed,
				transition: "success",
			}),
		).toMatchObject({ status: "transitioned", eventSeq: 3 });
		expect(
			await transitionRunTerminalTx(tdb.db, {
				...claimed,
				transition: "success",
			}),
		).toEqual({ status: "lost_ownership_or_not_transitionable" });
		expect(await terminalEvents("run-1")).toEqual([
			{
				seq: 3,
				type: RUN_EVENT_TYPES.runDone,
				visibility: "client",
				payload: {},
			},
		]);
	});

	it("cancellation terminalization is allowed from cancel_requested", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		await requestRunCancellationTx(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});

		expect(
			await transitionRunTerminalTx(tdb.db, {
				...claimed,
				transition: "cancellation",
			}),
		).toEqual({
			status: "transitioned",
			runStatus: "canceled",
			eventSeq: 4,
		});
		expect(await terminalEvents("run-1")).toEqual([
			{
				seq: 4,
				type: RUN_EVENT_TYPES.runCanceled,
				visibility: "client",
				payload: {},
			},
		]);
	});

	it("failure after cancel_requested maps to canceled", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		await requestRunCancellationTx(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});

		expect(
			await transitionRunTerminalTx(tdb.db, {
				...claimed,
				transition: "failure",
				message: "SDK interrupt failed",
			}),
		).toEqual({
			status: "transitioned",
			runStatus: "canceled",
			eventSeq: 4,
		});
		expect(await terminalEvents("run-1")).toEqual([
			{
				seq: 4,
				type: RUN_EVENT_TYPES.runCanceled,
				visibility: "client",
				payload: {},
			},
		]);
	});

	it("recoverOneStaleRunTx terminalizes at most one stale run per call", async () => {
		await createRun("run-1", "user-1", "conv-1");
		await createRun("run-2", "user-1", "conv-2");
		const first = await claimRun("worker-1");
		const second = await claimRun("worker-2");
		await expireRun(first.runId);
		await expireRun(second.runId);

		const recovered = await recoverOneStaleRunTx(tdb.db);

		expect(recovered?.runId).toBe("run-1");
		expect(
			(await tdb.db.select().from(runs)).filter(
				(run) => run.status === "error" || run.status === "canceled",
			),
		).toHaveLength(1);
	});

	it("stale running becomes error with a client-safe run_error", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		await expireRun(claimed.runId);

		expect(await recoverOneStaleRunTx(tdb.db)).toMatchObject({
			runId: "run-1",
			runStatus: "error",
			eventSeq: 3,
		});
		expect(await getRun("run-1")).toMatchObject({
			status: "error",
			lockedBy: null,
			lockedUntil: null,
			fencingToken: 2,
		});
		expect(await terminalEvents("run-1")).toEqual([
			{
				seq: 3,
				type: RUN_EVENT_TYPES.runError,
				visibility: "client",
				payload: {
					message: "The run was stopped because its worker became unavailable.",
				},
			},
		]);
	});

	it("stale cancel_requested becomes canceled", async () => {
		await createRun("run-1", "user-1", "conv-1");
		const claimed = await claimRun();
		await requestRunCancellationTx(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});
		await expireRun(claimed.runId);

		expect(await recoverOneStaleRunTx(tdb.db)).toMatchObject({
			runId: "run-1",
			runStatus: "canceled",
			eventSeq: 4,
		});
		expect(await getRun("run-1")).toMatchObject({
			status: "canceled",
			lockedBy: null,
			lockedUntil: null,
			fencingToken: 2,
		});
		expect(await terminalEvents("run-1")).toEqual([
			{
				seq: 4,
				type: RUN_EVENT_TYPES.runCanceled,
				visibility: "client",
				payload: {},
			},
		]);
	});

	async function createRun(
		runId: string,
		userId = "user-1",
		conversationId = "conv-1",
	) {
		return createQueuedRunTx(tdb.db, { runId, userId, conversationId });
	}

	async function claimRun(workerId = "worker-1"): Promise<ClaimedRun> {
		const claimed = await claimNextRunTx(tdb.db, { workerId, ttlMs: TTL });
		if (!claimed) throw new Error("expected a queued run");
		return claimed;
	}

	async function expireRun(runId: string) {
		await tdb.db
			.update(runs)
			.set({ lockedUntil: sql`now() - make_interval(secs => 60)` })
			.where(eq(runs.runId, runId));
	}

	async function getRun(runId: string) {
		const rows = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, runId))
			.limit(1);
		return rows[0] ?? null;
	}

	async function getEvents(runId: string) {
		return tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, runId))
			.orderBy(runEvents.seq);
	}

	async function compactEvents(runId: string) {
		return (await getEvents(runId)).map((event) => ({
			seq: event.seq,
			type: event.type,
			visibility: event.visibility,
			payload: event.payload,
		}));
	}

	async function terminalEvents(runId: string) {
		const terminalTypes = new Set<string>([
			RUN_EVENT_TYPES.runDone,
			RUN_EVENT_TYPES.runError,
			RUN_EVENT_TYPES.runCanceled,
		]);
		return (await compactEvents(runId)).filter((event) =>
			terminalTypes.has(event.type),
		);
	}
});
