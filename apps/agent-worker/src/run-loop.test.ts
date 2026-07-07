import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	appendRunEventTx,
	claimNextRunTx,
	createQueuedRunTx,
	RunFenceError,
	requestRunCancellationTx,
} from "@mymemo/agent-db/run-store";
import {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
	updateRuntimeSandboxTx,
} from "@mymemo/agent-db/runtime-store";
import { runEvents, runs } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "./logger";
import { RunLoop, type RunProcessor } from "./run-loop";
import type { SnapshotSandbox } from "./snapshot-barrier";
import { Worker } from "./worker";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

beforeEach(async () => {
	tdb = await createTestDatabase();
});

afterEach(async () => {
	await tdb.close();
});

/** A promise whose resolution the test controls, to gate a processor. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function buildWorker(maxConcurrentRuns: number, workerId = "worker-1") {
	return new Worker({
		workerId,
		maxConcurrentRuns,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
}

function buildLoop(worker: Worker, processor: RunProcessor) {
	return new RunLoop({
		db: tdb.db,
		worker,
		processor,
		heartbeatIntervalMs: 15_000,
		logger: silentLogger,
	});
}

async function queueRun(runId: string, conversationId: string) {
	await createQueuedRunTx(tdb.db, { runId, userId: "user-1", conversationId });
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

async function expireOwnership(runId: string) {
	await tdb.db
		.update(runs)
		.set({ lockedUntil: sql`now() - interval '1 second'` })
		.where(eq(runs.runId, runId));
}

async function readRun(runId: string) {
	const [row] = await tdb.db.select().from(runs).where(eq(runs.runId, runId));
	return row;
}

async function readEventTypes(runId: string) {
	const rows = await tdb.db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(runEvents.seq);
	return rows.map((e) => e.type);
}

/** Appends one text delta then returns — the Milestone 3 synthetic turn. */
const appendTextProcessor: RunProcessor = async (ctx) => {
	await ctx.appendText(`synthetic ${ctx.run.runId}`);
};

/** A checkpoint seam that counts calls, for the snapshot-barrier integration. */
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

/** Stand up the owned conversation's runtime row + sandbox pointer from inside
 * a processor — the state a real turn reaches before it reports dirty work. */
async function standUpRuntime(runId: string, conversationId: string) {
	const owner = {
		userId: "user-1",
		conversationId,
		runId,
		workerId: "worker-1",
	};
	await createConversationRuntimeTx(tdb.db, owner);
	await updateRuntimeSandboxTx(tdb.db, { ...owner, sandboxId: "sbx-1" });
}

async function readRuntime(conversationId: string) {
	return loadConversationRuntimeTx(tdb.db, {
		userId: "user-1",
		conversationId,
	});
}

describe("RunLoop — concurrency", () => {
	it("claims at most the configured concurrency in one tick", async () => {
		const worker = buildWorker(1);
		// Block processing so a claimed run stays active across the assertions.
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-2");

		const claimed = await loop.tick();

		expect(claimed).toBe(1);
		expect(worker.activeCount).toBe(1);
		// The second run is left queued for a later tick / another worker.
		expect((await readRun("run-2"))?.status).toBe("queued");

		gate.resolve();
		await worker.drain();
	});

	it("claims the next run once a slot frees", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendTextProcessor);
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-2");

		expect(await loop.tick()).toBe(1);
		await worker.drain();
		expect(await loop.tick()).toBe(1);
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect((await readRun("run-2"))?.status).toBe("done");
	});
});

describe("RunLoop — claim isolation", () => {
	it("never hands the same run to two workers", async () => {
		const workerA = buildWorker(2, "worker-a");
		const workerB = buildWorker(2, "worker-b");
		const gate = deferred();
		const block: RunProcessor = async () => {
			await gate.promise;
		};
		const loopA = buildLoop(workerA, block);
		const loopB = new RunLoop({
			db: tdb.db,
			worker: workerB,
			processor: block,
			heartbeatIntervalMs: 15_000,
			logger: silentLogger,
		});
		await queueRun("run-1", "conv-1");

		const claimedA = await loopA.tick();
		const claimedB = await loopB.tick();

		expect(claimedA).toBe(1);
		expect(claimedB).toBe(0);
		expect((await readRun("run-1"))?.lockedBy).toBe("worker-a");

		gate.resolve();
		await workerA.drain();
		await workerB.drain();
	});
});

describe("RunLoop — heartbeat", () => {
	it("renews the lock deadline for a run it owns", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)

		// Pull the deadline near expiry so the fixed-duration renewal is visible.
		await tdb.db
			.update(runs)
			.set({ lockedUntil: sql`now() + interval '1 second'` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeats the active run

		const row = await readRun("run-1");
		expect(row?.lockedBy).toBe("worker-1");
		expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now() + 30_000);

		gate.resolve();
		await worker.drain();
	});

	it("abandons a run whose ownership it lost without terminalizing it", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		// A processor that ignores the abort signal — proves abandonment does not
		// depend on the processor cooperating.
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)

		// Another worker steals the run: the heartbeat fence (locked_by = us) is
		// now rejected, so heartbeatRunTx returns null.
		await tdb.db
			.update(runs)
			.set({
				lockedBy: "worker-2",
				lockedUntil: sql`now() + interval '60 seconds'`,
			})
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeat observes the lost fence → abandons
		gate.resolve();
		await worker.drain();

		// We must not terminalize a run we no longer own: no terminal event from
		// us, and the thief's ownership is untouched (recovery is its problem now).
		const row = await readRun("run-1");
		expect(row?.status).toBe("running");
		expect(row?.lockedBy).toBe("worker-2");
		expect(await readEventTypes("run-1")).toEqual([]);
	});
});

describe("RunLoop — terminal outcomes", () => {
	it("completes a synthetic run as done with a text event", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendTextProcessor);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		// The worker writes the shared `assistant_text` type; chat-api's projector
		// maps it to the `text_delta` client frame.
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_text",
			"run_done",
		]);
	});

	it("terminalizes a failed synthetic run as error with the message", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async () => {
			throw new Error("synthetic boom");
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		const row = await readRun("run-1");
		expect(row?.status).toBe("error");
		const [event] = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"));
		expect(event?.type).toBe("run_error");
		expect((event?.payload as { message?: string })?.message).toBe(
			"synthetic boom",
		);
	});

	it("terminalizes as canceled when cancellation is observed mid-processing", async () => {
		const worker = buildWorker(1);
		// A processor that runs until the run is aborted, without appending.
		const loop = buildLoop(worker, async (ctx) => {
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve();
				ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor now blocking on abort)

		// User requests cancellation while the run is executing.
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested", cancelRequestedAt: sql`now()` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeat observes cancel_requested → aborts the run
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("canceled");
		expect(await readEventTypes("run-1")).toEqual(["run_canceled"]);
	});
});

describe("RunLoop — snapshot barrier", () => {
	it("completes a clean turn as done without taking a snapshot", async () => {
		const worker = buildWorker(1);
		const { sandbox, state } = countingSandbox();
		const loop = buildLoop(worker, async (ctx) => {
			await ctx.appendText(`clean ${ctx.run.runId}`);
			return { workspaceDirty: false, sandbox };
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_text",
			"run_done",
		]);
		expect(state.calls).toBe(0);
	});

	it("snapshots a dirty turn once and records the checkpoint before done", async () => {
		const worker = buildWorker(1);
		const { sandbox, state } = countingSandbox(async () => "snap-99");
		const loop = buildLoop(worker, async (ctx) => {
			await standUpRuntime(ctx.run.runId, ctx.run.conversationId);
			await ctx.appendText(`work ${ctx.run.runId}`);
			return { workspaceDirty: true, sandbox };
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_text",
			"run_done",
		]);
		expect(state.calls).toBe(1);
		expect(await readRuntime("conv-1")).toMatchObject({
			latestSnapshotId: "snap-99",
			workspaceCheckpointStatus: "clean",
		});
	});

	it("terminalizes as error and marks dirty_uncheckpointed when the snapshot fails", async () => {
		const worker = buildWorker(1);
		const { sandbox } = countingSandbox(async () => {
			throw new Error("e2b snapshot failed");
		});
		const loop = buildLoop(worker, async (ctx) => {
			await standUpRuntime(ctx.run.runId, ctx.run.conversationId);
			await ctx.appendText(`work ${ctx.run.runId}`);
			return { workspaceDirty: true, sandbox };
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_text",
			"run_error",
		]);
		expect(await readRuntime("conv-1")).toMatchObject({
			latestSnapshotId: null,
			workspaceCheckpointStatus: "dirty_uncheckpointed",
		});
	});

	it("lets cancellation win over a dirty successful turn without snapshotting", async () => {
		const worker = buildWorker(1);
		const { sandbox, state } = countingSandbox();
		// The turn runs until aborted, then reports dirty work — a would-be
		// successful checkpoint that cancellation must beat at the terminal.
		const loop = buildLoop(worker, async (ctx) => {
			await standUpRuntime(ctx.run.runId, ctx.run.conversationId);
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve();
				ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return { workspaceDirty: true, sandbox };
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks on abort)

		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested", cancelRequestedAt: sql`now()` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeat observes cancel_requested → aborts the run
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("canceled");
		expect(await readEventTypes("run-1")).toEqual(["run_canceled"]);
		expect(state.calls).toBe(0);
	});
});

describe("RunLoop — agent session pointer", () => {
	it("advances the resume pointer on a successful turn that reports a session", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			// The runtime row is created while the run is owned (as E2B provisioning
			// will), so the fenced pointer advance in `finish()` has a row to update.
			await createConversationRuntimeTx(tdb.db, {
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
				runId: ctx.run.runId,
				workerId: "worker-1",
			});
			return {
				workspaceDirty: false,
				sandbox: null,
				agentSession: { sessionId: "session-abc" },
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readRuntime("conv-1")).toMatchObject({
			agentSessionId: "session-abc",
		});
	});

	it("terminalizes done without advancing the pointer when the turn reported a mirror error", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, {
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
				runId: ctx.run.runId,
				workerId: "worker-1",
			});
			// A mirror_error turn drops the session id → agentSession is null.
			return { workspaceDirty: false, sandbox: null, agentSession: null };
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readRuntime("conv-1")).toMatchObject({ agentSessionId: null });
	});
});

describe("RunLoop — shutdown", () => {
	it("interrupts in-flight runs on stop and terminalizes them as error", async () => {
		const worker = buildWorker(1);
		let sawAbort = false;
		// A processor that mirrors the SDK consumer: it runs until the run is
		// aborted, then throws — so shutdown never records a clean `done`.
		const loop = buildLoop(worker, async (ctx) => {
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve();
				ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			sawAbort = ctx.signal.aborted;
			throw new Error("interrupted by shutdown");
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch; processor blocks awaiting abort

		await loop.stop(); // aborts the active run, then drains

		expect(sawAbort).toBe(true);
		const row = await readRun("run-1");
		expect(row?.status).toBe("error");
		expect(await readEventTypes("run-1")).toEqual(["run_error"]);
	});
});

describe("RunLoop — stale-run recovery", () => {
	it("terminalizes stale running runs as error during a tick", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await expireOwnership("run-stale");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendTextProcessor);

		const claimed = await loop.tick();
		await worker.drain();

		expect(claimed).toBe(0);
		expect((await readRun("run-stale"))?.status).toBe("error");
		expect(await readEventTypes("run-stale")).toEqual(["run_error"]);
	});

	it("terminalizes stale cancel-requested runs as canceled during a tick", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await requestRunCancellationTx(tdb.db, {
			runId: "run-stale",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await expireOwnership("run-stale");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendTextProcessor);

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-stale"))?.status).toBe("canceled");
		expect(await readEventTypes("run-stale")).toEqual(["run_canceled"]);
	});

	it("rejects stale worker appends after loop recovery terminalizes the run", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await expireOwnership("run-stale");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendTextProcessor);

		await loop.tick();

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-stale",
				workerId: "stale-worker",
				type: "assistant_text",
				payload: { text: "too late" },
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
		expect(await readEventTypes("run-stale")).toEqual(["run_error"]);
	});

	it("does not double-terminalize when recovery beats an active processor", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)
		await expireOwnership("run-1");

		await loop.tick(); // recovers stale run, then observes lost ownership
		gate.resolve();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readEventTypes("run-1")).toEqual(["run_error"]);
	});
});

describe("RunLoop — synthetic end-to-end smoke", () => {
	it("claims a queued run, streams a text event, and completes it", async () => {
		const worker = buildWorker(2);
		const loop = buildLoop(worker, appendTextProcessor);
		// A conversation queued a run (chat-api's admission side, mirrored here).
		await queueRun("run-smoke", "conv-smoke");

		const claimed = await loop.tick();
		await worker.drain();

		expect(claimed).toBe(1);
		const row = await readRun("run-smoke");
		expect(row?.status).toBe("done");
		expect(row?.lockedBy).toBeNull();
		// The durable event log — the single SSE source — carries the streamed
		// assistant text (projected to `text_delta`) ahead of the terminal frame.
		expect(await readEventTypes("run-smoke")).toEqual([
			"assistant_text",
			"run_done",
		]);
	});
});
