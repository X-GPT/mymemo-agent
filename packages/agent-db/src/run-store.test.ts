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
	ActiveRunConflictError,
	appendRunEventTx,
	claimNextRunTx,
	createQueuedRunTx,
	heartbeatRunTx,
	markStaleRunsTx,
	RunFenceError,
	requestRunCancellationTx,
	transitionRunTerminalTx,
} from "./run-store";
import { runEvents, runs } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

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
});

describe("createQueuedRunTx", () => {
	it("creates a queued run with queue defaults", async () => {
		const run = await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(run).toMatchObject({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			lockedBy: null,
			lockedUntil: null,
			heartbeatAt: null,
			cancelRequestedAt: null,
			nextEventSeq: 1,
			terminalAt: null,
		});
	});

	it("rejects a second active run for the same conversation", async () => {
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await expect(
			createQueuedRunTx(tdb.db, {
				runId: "run-2",
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).rejects.toBeInstanceOf(ActiveRunConflictError);
	});

	it("allows a new run once the previous run is terminal", async () => {
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await tdb.db
			.update(runs)
			.set({ status: "done" })
			.where(eq(runs.runId, "run-1"));

		const next = await createQueuedRunTx(tdb.db, {
			runId: "run-2",
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(next.status).toBe("queued");
	});
});

async function queueRun(runId: string, conversationId: string) {
	return await createQueuedRunTx(tdb.db, {
		runId,
		userId: "user-1",
		conversationId,
	});
}

/** Push a run's created_at into the past so claim-order tests are deterministic
 * (PGlite can give two inserts the same timestamp). */
async function backdateRun(runId: string, msAgo: number) {
	await tdb.db
		.update(runs)
		.set({ createdAt: sql`now() - (${msAgo} * interval '1 millisecond')` })
		.where(eq(runs.runId, runId));
}

describe("claimNextRunTx", () => {
	it("returns null when no run is queued", async () => {
		const claimed = await claimNextRunTx(tdb.db, { workerId: "worker-1" });
		expect(claimed).toBeNull();
	});

	it("claims the oldest queued run and takes execution ownership", async () => {
		await queueRun("run-newer", "conv-1");
		await queueRun("run-older", "conv-2");
		await backdateRun("run-older", 5_000);

		const claimed = await claimNextRunTx(tdb.db, { workerId: "worker-1" });

		expect(claimed).toMatchObject({
			runId: "run-older",
			status: "running",
			lockedBy: "worker-1",
		});
		expect(claimed?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
		expect(claimed?.heartbeatAt).toBeInstanceOf(Date);
	});

	// PGlite is single-connection, so this exercises the claim CAS, not true
	// cross-connection FOR UPDATE SKIP LOCKED contention — that is covered by
	// the local-Postgres integration layer of the testing plan.
	it("never hands the same run to two claimants", async () => {
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-2");

		const first = await claimNextRunTx(tdb.db, { workerId: "worker-1" });
		const second = await claimNextRunTx(tdb.db, { workerId: "worker-2" });
		const third = await claimNextRunTx(tdb.db, { workerId: "worker-3" });

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(first?.runId).not.toBe(second?.runId);
		expect(third).toBeNull();
	});
});

/** Queue and claim one run so append/terminal tests start from a live claim. */
async function claimRun(
	runId: string,
	conversationId: string,
	workerId: string,
) {
	await queueRun(runId, conversationId);
	await backdateRun(runId, 5_000);
	const claimed = await claimNextRunTx(tdb.db, { workerId });
	if (claimed?.runId !== runId) {
		throw new Error(`test setup claimed ${claimed?.runId}, wanted ${runId}`);
	}
	return claimed;
}

/** Force a claimed run's locked_until past, as if the worker stalled. */
async function expireOwnership(runId: string) {
	await tdb.db
		.update(runs)
		.set({ lockedUntil: sql`now() - interval '1 second'` })
		.where(eq(runs.runId, runId));
}

async function readEvents(runId: string) {
	return await tdb.db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(runEvents.seq);
}

describe("appendRunEventTx", () => {
	it("allocates monotonic database-owned sequence numbers", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const first = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: "text_delta",
			payload: { text: "hel" },
			appendClass: "model",
		});
		const second = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: "text_delta",
			payload: { text: "lo" },
			appendClass: "model",
		});

		expect(first.seq).toBe(1);
		expect(second.seq).toBe(2);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([
			[1, "text_delta"],
			[2, "text_delta"],
		]);
		expect(events[0]?.payload).toEqual({ text: "hel" });
	});

	it("rejects a model append on a run that is not running", async () => {
		await queueRun("run-1", "conv-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: "text_delta",
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("rejects an append from a worker that does not own the run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-2",
				type: "text_delta",
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("rejects a stale worker append after locked_until has passed", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: "text_delta",
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("rejects model appends after cancellation is requested", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: "text_delta",
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("allows cancellation audit appends while running or cancel_requested", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const whileRunning = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: "model_interrupt_requested",
			payload: {},
			appendClass: "cancellation",
		});
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));
		const whileCancelRequested = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: "command_canceled",
			payload: {},
			appendClass: "cancellation",
		});

		expect(whileRunning.seq).toBe(1);
		expect(whileCancelRequested.seq).toBe(2);
	});

	it("still fences cancellation audit appends by lock deadline", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));
		await expireOwnership("run-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: "command_canceled",
				payload: {},
				appendClass: "cancellation",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});

describe("transitionRunTerminalTx", () => {
	it("completes a running run and appends exactly one run_done event", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: "text_delta",
			payload: { text: "hi" },
			appendClass: "model",
		});

		const run = await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		expect(run).toMatchObject({
			runId: "run-1",
			status: "done",
			lockedBy: null,
			lockedUntil: null,
		});
		expect(run.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([
			[1, "text_delta"],
			[2, "run_done"],
		]);
	});

	it("rejects a second terminal transition for the same run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "error",
				payload: { message: "boom" },
			}),
		).rejects.toBeInstanceOf(RunFenceError);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_done"]);
	});

	it("refuses done once cancellation was requested; canceled wins", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "done",
			}),
		).rejects.toBeInstanceOf(RunFenceError);

		const run = await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "canceled",
		});
		expect(run.status).toBe("canceled");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_canceled"]);
	});

	it("refuses error once cancellation was requested", async () => {
		// "Do not overload `error` for user-initiated cancellation": after
		// cancel_requested the only legal terminal is canceled, even when the
		// SDK errors during the interrupt.
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "error",
				payload: { message: "sdk exploded mid-interrupt" },
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("marks a running run as error with the error payload", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const run = await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "error",
			payload: { message: "sandbox died" },
		});

		expect(run.status).toBe("error");
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.type, e.payload])).toEqual([
			["run_error", { message: "sandbox died" }],
		]);
	});

	it("rejects a terminal transition from a non-owner or expired ownership", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-2",
				status: "done",
			}),
		).rejects.toBeInstanceOf(RunFenceError);

		await expireOwnership("run-1");
		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "done",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});

describe("requestRunCancellationTx", () => {
	const ref = { runId: "run-1", userId: "user-1", conversationId: "conv-1" };

	it("cancels a queued run immediately and appends run_canceled", async () => {
		await queueRun("run-1", "conv-1");

		const result = await requestRunCancellationTx(tdb.db, ref);

		expect(result.outcome).toBe("canceled");
		if (result.outcome !== "canceled") throw new Error("unreachable");
		expect(result.run).toMatchObject({
			runId: "run-1",
			status: "canceled",
			lockedBy: null,
			lockedUntil: null,
		});
		expect(result.run.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([[1, "run_canceled"]]);
	});

	it("moves a running run to cancel_requested and leaves ownership intact", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const result = await requestRunCancellationTx(tdb.db, ref);

		expect(result.outcome).toBe("cancel_requested");
		if (result.outcome !== "cancel_requested") throw new Error("unreachable");
		expect(result.run.status).toBe("cancel_requested");
		expect(result.run.lockedBy).toBe("worker-1");
		expect(result.run.cancelRequestedAt).toBeInstanceOf(Date);
		// No terminal event yet: the owning worker appends run_canceled when it
		// actually terminalizes.
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("is idempotent while cancellation is already requested", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await requestRunCancellationTx(tdb.db, ref);

		const again = await requestRunCancellationTx(tdb.db, ref);

		expect(again.outcome).toBe("cancel_requested");
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("reports an already-terminal run without touching it", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		const result = await requestRunCancellationTx(tdb.db, ref);

		expect(result.outcome).toBe("already_terminal");
		if (result.outcome !== "already_terminal") throw new Error("unreachable");
		expect(result.run.status).toBe("done");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_done"]);
	});

	it("reports not_found for missing or foreign runs", async () => {
		await queueRun("run-1", "conv-1");

		expect(
			await requestRunCancellationTx(tdb.db, {
				...ref,
				runId: "run-ghost",
			}),
		).toEqual({ outcome: "not_found" });
		expect(
			await requestRunCancellationTx(tdb.db, {
				...ref,
				userId: "user-2",
			}),
		).toEqual({ outcome: "not_found" });
		expect(
			await requestRunCancellationTx(tdb.db, {
				...ref,
				conversationId: "conv-2",
			}),
		).toEqual({ outcome: "not_found" });
	});
});

describe("heartbeatRunTx", () => {
	it("extends the lock deadline for the owning worker", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		// Pull the deadline near expiry so the fixed-duration renewal is visible.
		await tdb.db
			.update(runs)
			.set({ lockedUntil: sql`now() + interval '1 second'` })
			.where(eq(runs.runId, "run-1"));

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed).not.toBeNull();
		expect(renewed?.lockedUntil?.getTime()).toBeGreaterThan(
			Date.now() + 30_000,
		);
		expect(renewed?.heartbeatAt).toBeInstanceOf(Date);
	});

	it("lets the control loop observe a pending cancellation request", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await requestRunCancellationTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed?.status).toBe("cancel_requested");
		expect(renewed?.cancelRequestedAt).toBeInstanceOf(Date);
	});

	it("does not renew for a worker that does not own the run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-2",
		});

		expect(renewed).toBeNull();
	});

	it("does not revive expired ownership", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed).toBeNull();
	});

	it("does not renew a terminal run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed).toBeNull();
	});
});

describe("markStaleRunsTx", () => {
	it("terminalizes a stale running run as error with a run_error event", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered.map((r) => [r.runId, r.status])).toEqual([
			["run-1", "error"],
		]);
		expect(recovered[0]?.lockedBy).toBeNull();
		expect(recovered[0]?.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
	});

	it("terminalizes a stale cancel_requested run as canceled", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await requestRunCancellationTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await expireOwnership("run-1");

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered.map((r) => [r.runId, r.status])).toEqual([
			["run-1", "canceled"],
		]);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_canceled"]);
	});

	it("leaves queued runs and live claims alone", async () => {
		await queueRun("run-queued", "conv-1");
		await claimRun("run-live", "conv-2", "worker-1");

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered).toEqual([]);
		const [queued] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-queued"));
		const [live] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-live"));
		expect(queued?.status).toBe("queued");
		expect(live?.status).toBe("running");
	});

	it("terminalizes old unclaimed queued runs as error", async () => {
		await queueRun("run-queued", "conv-1");
		await tdb.db
			.update(runs)
			.set({ createdAt: sql`now() - interval '2 minutes'` })
			.where(eq(runs.runId, "run-queued"));

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered.map((r) => [r.runId, r.status])).toEqual([
			["run-queued", "error"],
		]);
		const events = await readEvents("run-queued");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
	});

	it("never double-terminalizes: a second sweep finds nothing", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");
		await markStaleRunsTx(tdb.db);

		const again = await markStaleRunsTx(tdb.db);

		expect(again).toEqual([]);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
	});

	it("rejects the stale worker's appends once recovery has terminalized", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");
		await markStaleRunsTx(tdb.db);

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: "text_delta",
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});
