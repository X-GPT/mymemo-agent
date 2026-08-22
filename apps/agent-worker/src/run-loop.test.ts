import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import { claimConversationTx } from "@mymemo/agent-db/conversation-ownership";
import {
	appendRunEventTx,
	requestRunInterruptionTx,
	startClaimedRunTx,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";
import {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
} from "@mymemo/agent-db/runtime-store";
import {
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import {
	createTestDatabase,
	lapseConversationOwnership,
	seedQueuedRun,
	type TestDb,
} from "@mymemo/agent-db/testing";
import {
	createInMemoryLiveStreamRelay,
	decodeAgUiLiveStreamEvent,
	type LiveStreamRelay,
	type LiveStreamTelemetry,
} from "@mymemo/live-text";
import { eq, inArray, sql } from "drizzle-orm";
import type { WorkerLogger } from "./logger";
import { RunLoop } from "./run-loop";
import type { RunProcessor } from "./run-serving";
import { Worker } from "./worker";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase(undefined, { legacyFargate: true });
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
});

/** A promise whose resolution the test controls, to gate a processor. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function buildWorker(
	maxConcurrentConversations: number,
	workerId = "worker-1",
) {
	return new Worker({
		workerId,
		maxConcurrentConversations,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
}

function buildLoop(
	worker: Worker,
	processor: RunProcessor,
	liveStreamRelay: LiveStreamRelay = createInMemoryLiveStreamRelay(),
	liveStreamTelemetry?: LiveStreamTelemetry,
) {
	return new RunLoop({
		db: tdb.db,
		worker,
		processor,
		liveStreamRelay,
		liveStreamTelemetry,
		heartbeatIntervalMs: 15_000,
		logger: silentLogger,
	});
}

/** Claim and dispatch, then wait until the drain has actually started serving —
 * the Claim's own tick returns before the dispatched drain reaches its first
 * Run, so every drain test needs this before it can act on the Run in flight. */
async function startDrain(loop: RunLoop, runId = "run-1") {
	await loop.tick();
	await waitUntil(
		async () => (await readRun(runId))?.status === "running",
		`the drain to start serving ${runId}`,
	);
}

async function queueRun(runId: string, conversationId: string) {
	await tdb.db
		.insert(conversations)
		.values({
			userId: "user-1",
			conversationId,
			scope: "general",
			executionRuntime: "fargate",
		})
		.onConflictDoNothing();
	await seedQueuedRun(tdb.db, { runId, userId: "user-1", conversationId });
}

async function claimRun(
	runId: string,
	conversationId: string,
	workerId: string,
) {
	await queueRun(runId, conversationId);
	const claim = await claimConversationTx(tdb.db, { workerId });
	if (!claim || !claim.runIds.includes(runId)) {
		throw new Error(`test setup did not Claim ${runId}`);
	}
	const started = await startClaimedRunTx(tdb.db, {
		owner: claim,
		runId,
		workerId,
	});
	if (started.outcome !== "started") {
		throw new Error(`test setup could not start ${runId}`);
	}
	return claim;
}

function lapseOwnershipLease(conversationId: string) {
	return lapseConversationOwnership(tdb.db, {
		userId: "user-1",
		conversationId,
	});
}

async function readRun(runId: string) {
	const [row] = await tdb.db.select().from(runs).where(eq(runs.runId, runId));
	return row;
}

/** Push a run's created_at into the past so snapshot order is deterministic
 * (PGlite can give two inserts the same timestamp). */
async function backdateRun(runId: string, msAgo: number) {
	await tdb.db
		.update(runs)
		.set({ createdAt: sql`now() - (${msAgo} * interval '1 millisecond')` })
		.where(eq(runs.runId, runId));
}

async function ageRunsPastQueueTimeout(...runIds: string[]) {
	await tdb.db
		.update(runs)
		.set({
			createdAt: sql`now() - interval '2 minutes'`,
			updatedAt: sql`now() - interval '2 minutes'`,
		})
		.where(inArray(runs.runId, runIds));
}

async function readOwnership(conversationId: string) {
	const [row] = await tdb.db
		.select({
			ownerWorkerId: conversations.ownerWorkerId,
			ownerUntil: conversations.ownerUntil,
		})
		.from(conversations)
		.where(eq(conversations.conversationId, conversationId));
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

/** Appends one complete Assistant message then returns. */
const appendMessageProcessor: RunProcessor = async (ctx) => {
	await ctx.appendModelContent({
		kind: "assistant_message",
		payload: {
			messageId: `message-${ctx.run.runId}`,
			text: `synthetic ${ctx.run.runId}`,
		},
	});
};

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
		const loop = buildLoop(worker, appendMessageProcessor);
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
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: block,
			heartbeatIntervalMs: 15_000,
			logger: silentLogger,
		});
		await queueRun("run-1", "conv-1");

		const claimedA = await loopA.tick();
		const claimedB = await loopB.tick();

		expect(claimedA).toBe(1);
		expect(claimedB).toBe(0);
		expect((await readRun("run-1"))?.executedByWorkerId).toBe("worker-a");

		gate.resolve();
		await workerA.drain();
		await workerB.drain();
	});
});

describe("RunLoop — Ownership renewal", () => {
	it("renews the Conversation deadline while serving a Run", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)

		// Pull the deadline near expiry so the fixed-duration renewal is visible.
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, "conv-1"));

		await loop.tick(); // renews the active Conversation

		const ownership = await readOwnership("conv-1");
		expect(ownership?.ownerWorkerId).toBe("worker-1");
		expect(ownership?.ownerUntil?.getTime()).toBeGreaterThan(
			Date.now() + 30_000,
		);

		gate.resolve();
		await worker.drain();
	});

	it("abandons a Run whose Conversation ownership it lost", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		// A processor that ignores the abort signal — proves abandonment does not
		// depend on the processor cooperating.
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)

		// A later Claim supersedes this one. The next renewal rejects the stale epoch.
		await tdb.db
			.update(conversations)
			.set({
				epoch: sql`${conversations.epoch} + 1`,
				ownerWorkerId: "worker-2",
				ownerUntil: sql`now() + interval '60 seconds'`,
			})
			.where(eq(conversations.conversationId, "conv-1"));

		await loop.tick(); // Ownership renewal observes the lost fence → abandons
		gate.resolve();
		await worker.drain();

		// We must not terminalize a Run we no longer own: no terminal event from us,
		// and the successor's Conversation ownership is untouched.
		const row = await readRun("run-1");
		expect(row?.status).toBe("running");
		expect(row?.executedByWorkerId).toBe("worker-1");
		expect((await readOwnership("conv-1"))?.ownerWorkerId).toBe("worker-2");
		expect(await readEventTypes("run-1")).toEqual([]);
	});
});

describe("RunLoop — conversation drain", () => {
	it("serves a Claimed Conversation's snapshot in submission order", async () => {
		const worker = buildWorker(1);
		const served: string[] = [];
		const loop = buildLoop(worker, async (ctx) => {
			served.push(ctx.run.runId);
		});
		await queueRun("run-second", "conv-1");
		await queueRun("run-first", "conv-1");
		await backdateRun("run-first", 5_000);

		// One slot for the whole drain: two Runs, one Claimed Conversation.
		const claimed = await loop.tick();
		await worker.drain();

		expect(claimed).toBe(1);
		expect(served).toEqual(["run-first", "run-second"]);
		expect((await readRun("run-first"))?.status).toBe("done");
		expect((await readRun("run-second"))?.status).toBe("done");
		// Released, so the Conversation is immediately claimable again.
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: null,
			ownerUntil: null,
		});
	});

	it("halts without terminalizing or releasing once the Ownership lease is lost", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		// Ignores the abort signal, so halting cannot depend on the processor.
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-1");
		await backdateRun("run-1", 5_000);
		await startDrain(loop);

		// Establish the successor state directly so this test isolates the drain's
		// lost-epoch response; the Claim/Reclamation handoff is covered at the DB seam.
		await tdb.db
			.update(conversations)
			.set({
				ownerWorkerId: "worker-2",
				ownerUntil: sql`now() + interval '1 minute'`,
				epoch: sql`${conversations.epoch} + 1`,
			})
			.where(eq(conversations.conversationId, "conv-1"));
		await loop.tick(); // renewal matches zero rows → halt
		gate.resolve();
		await worker.drain();

		// Abandoned, not terminalized: the successor's Runs are not ours to end.
		expect((await readRun("run-1"))?.status).toBe("running");
		expect(await readEventTypes("run-1")).toEqual([]);
		// Unstarted, and left for the successor rather than served under a dead lease.
		expect((await readRun("run-2"))?.status).toBe("queued");
		// Never released: releasing would revoke the successor's ownership.
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: "worker-2",
		});
	});

	it("halts when an append is the first write to discover a lapsed Ownership lease", async () => {
		const worker = buildWorker(1);
		const processorReady = deferred();
		const gate = deferred();
		const loop = buildLoop(worker, async (ctx) => {
			processorReady.resolve();
			await gate.promise;
			await ctx.appendModelContent({
				kind: "assistant_message",
				payload: { messageId: "message-too-late", text: "too late" },
			});
		});
		await queueRun("run-1", "conv-1");
		await startDrain(loop);
		await processorReady.promise;

		await lapseOwnershipLease("conv-1");
		gate.resolve();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("running");
		expect(await readEventTypes("run-1")).toEqual([]);
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: "worker-1",
			ownerUntil: expect.any(Date),
		});
	});

	it("lets interruption win when an append first observes interrupt_requested", async () => {
		const worker = buildWorker(1);
		const processorReady = deferred();
		const gate = deferred();
		const loop = buildLoop(worker, async (ctx) => {
			processorReady.resolve();
			await gate.promise;
			await ctx.appendModelContent({
				kind: "assistant_message",
				payload: { messageId: "message-too-late", text: "too late" },
			});
		});
		await queueRun("run-1", "conv-1");
		await startDrain(loop);
		await processorReady.promise;
		await requestRunInterruptionTx(tdb.db, {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
		});

		gate.resolve();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect(await readEventTypes("run-1")).toEqual(["run_interrupted"]);
	});

	it("lets Reclamation clear a lapsed lease while halting its old drain", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await startDrain(loop);

		await lapseOwnershipLease("conv-1"); // no successor yet
		await loop.tick(); // renewal matches zero rows → halt
		gate.resolve();
		await worker.drain();

		const ownership = await readOwnership("conv-1");
		expect(ownership).toMatchObject({
			ownerWorkerId: null,
			ownerUntil: null,
		});
		expect((await readRun("run-1"))?.status).toBe("error");
	});

	it("halts without releasing when a refused start is what reveals the lost lease", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async (ctx) => {
			if (ctx.run.runId === "run-1") await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-1");
		await backdateRun("run-1", 5_000);
		await startDrain(loop);

		// The lease lapses with no successor and no further tick, so the drain
		// learns of it from the next Run's refused start rather than from renewal.
		await lapseOwnershipLease("conv-1");
		gate.resolve();
		await worker.drain();

		expect((await readRun("run-2"))?.status).toBe("queued");
		// Same reason as a renewal-detected loss: releasing here would clear the
		// deadline Reclamation finds a lapsed lease by.
		const ownership = await readOwnership("conv-1");
		expect(ownership?.ownerWorkerId).toBe("worker-1");
		expect(ownership?.ownerUntil).toBeInstanceOf(Date);
	});

	it("stops observing a Run it abandoned, tick after tick", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const warnings: string[] = [];
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: async () => {
				await gate.promise;
			},
			heartbeatIntervalMs: 15_000,
			logger: {
				...silentLogger,
				warn: (event) => warnings.push(String(event.message)),
			},
		});
		await queueRun("run-1", "conv-1");
		await startDrain(loop);

		// Reclamation takes the whole Conversation after its Ownership lease lapses.
		await lapseOwnershipLease("conv-1");
		await loop.tick(); // reclaims the Run, then observes the lost lease
		await loop.tick();
		await loop.tick();
		gate.resolve();
		await worker.drain();

		// Detached on abandonment, so later ticks stop observing it.
		expect(
			warnings.filter(
				(message) =>
					message === "halting drain after losing the Ownership lease",
			),
		).toHaveLength(1);
	});

	it("skips a snapshot Run that reached its Outcome and serves the next", async () => {
		const worker = buildWorker(1);
		const served: string[] = [];
		const gate = deferred();
		const loop = buildLoop(worker, async (ctx) => {
			served.push(ctx.run.runId);
			if (ctx.run.runId === "run-1") await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-1");
		await queueRun("run-3", "conv-1");
		await backdateRun("run-1", 10_000);
		await backdateRun("run-2", 5_000);
		await startDrain(loop);

		// run-2 is interrupted while still queued, so it reaches its Outcome
		// underneath the worker between the snapshot and its start.
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-2",
			userId: "user-1",
			conversationId: "conv-1",
		});
		gate.resolve();
		await worker.drain();

		expect(served).toEqual(["run-1", "run-3"]);
		expect((await readRun("run-2"))?.status).toBe("interrupted");
		expect((await readRun("run-3"))?.status).toBe("done");
	});

	it("renews the Conversation while an abandoned Run unwinds", async () => {
		const worker = buildWorker(1);
		const processorStarted = deferred();
		const abandoned = deferred();
		const releaseProcessor = deferred();
		let firstOwner: Parameters<RunProcessor>[0]["owner"] | undefined;
		const loop = buildLoop(worker, async (ctx) => {
			if (ctx.run.runId !== "run-1") return;
			firstOwner = ctx.owner;
			if (ctx.ownershipLostSignal.aborted) abandoned.resolve();
			else {
				ctx.ownershipLostSignal.addEventListener(
					"abort",
					() => abandoned.resolve(),
					{ once: true },
				);
			}
			processorStarted.resolve();
			await abandoned.promise;
			await releaseProcessor.promise;
		});
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-1");
		await backdateRun("run-1", 5_000);
		await startDrain(loop);
		await processorStarted.promise;
		if (!firstOwner) throw new Error("processor did not expose its Run owner");

		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: firstOwner,
				status: "done",
			}),
		).toMatchObject({ outcome: "committed" });
		await loop.tick();
		await abandoned.promise;

		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, "conv-1"));
		await loop.tick();
		expect(
			(await readOwnership("conv-1"))?.ownerUntil?.getTime(),
		).toBeGreaterThan(Date.now() + 30_000);

		releaseProcessor.resolve();
		await worker.drain();
		expect((await readRun("run-2"))?.status).toBe("done");
	});

	it("leaves a Run submitted after the Claim to a later Claim", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async (ctx) => {
			if (ctx.run.runId === "run-1") await gate.promise;
		});
		await queueRun("run-1", "conv-1");
		await startDrain(loop);

		await queueRun("run-late", "conv-1"); // admitted mid-drain
		gate.resolve();
		await worker.drain();

		expect((await readRun("run-late"))?.status).toBe("queued");

		await loop.tick(); // the next Claim picks it up
		await worker.drain();

		expect((await readRun("run-late"))?.status).toBe("done");
	});

	it("stops the drain, with nothing to release, when the Conversation is gone", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const loop = buildLoop(worker, async (ctx) => {
			if (ctx.run.runId === "run-1") await gate.promise;
		});
		await queueRun("run-1", "conv-gone");
		await queueRun("run-2", "conv-gone");
		await backdateRun("run-1", 5_000);
		await startDrain(loop);

		// Permanent deletion takes the Conversation's Runs with it.
		await tdb.db
			.delete(conversations)
			.where(eq(conversations.conversationId, "conv-gone"));
		gate.resolve();
		await worker.drain();

		expect(worker.activeCount).toBe(0);
		// The worker stayed healthy: the next tick serves unrelated work.
		await queueRun("run-other", "conv-other");
		expect(await loop.tick()).toBe(1);
		await worker.drain();
		expect((await readRun("run-other"))?.status).toBe("done");
	});

	it("releases on shutdown so unstarted snapshot Runs requeue immediately", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve();
				ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("interrupted by shutdown");
		});
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-1");
		await backdateRun("run-1", 5_000);
		await startDrain(loop);

		await loop.stop();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect((await readRun("run-2"))?.status).toBe("queued");
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: null,
			ownerUntil: null,
		});
		// Immediately claimable, rather than waiting out the lease.
		expect(
			(await claimConversationTx(tdb.db, { workerId: "worker-2" }))?.runIds,
		).toEqual(["run-2"]);
	});
});

describe("RunLoop — terminal outcomes", () => {
	it("halts without release when the failure marker first observes lost ownership", async () => {
		let processorCalls = 0;
		const liveStreamRelay: LiveStreamRelay = {
			async openProducer() {
				await lapseConversationOwnership(tdb.db, {
					userId: "user-1",
					conversationId: "conv-1",
				});
				throw new Error("relay unavailable");
			},
			async attach() {
				return { outcome: "no_producer" };
			},
			async close() {},
		};
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async () => {
				processorCalls += 1;
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(processorCalls).toBe(0);
		expect((await readRun("run-1"))?.status).toBe("running");
		expect(await readEventTypes("run-1")).toEqual([]);
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: "worker-1",
			ownerUntil: expect.any(Date),
		});
	});

	it("marks the Live Stream failed and continues when the relay cannot open a producer", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		await liveStreamRelay.close();
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "assistant-1",
					delta: "not published",
				});
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "assistant-1", text: "still durable" },
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("commits durable facts before exposing AG-UI completion events", async () => {
		const observed: unknown[] = [];
		const processorStarted = deferred();
		const continueProcessor = deferred();
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				processorStarted.resolve();
				await continueProcessor.promise;
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_START,
					messageId: "assistant-1",
					role: "assistant",
				});
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "assistant-1",
					delta: "hello",
				});
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "assistant-1", text: "hello" },
				});
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_END,
					messageId: "assistant-1",
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await processorStarted.promise;
		const attached = await liveStreamRelay.attach(
			"run-1",
			new AbortController().signal,
		);
		if (attached.outcome !== "attached") throw new Error("expected attachment");
		const consume = (async () => {
			for await (const chunk of attached.events) {
				const event = decodeAgUiLiveStreamEvent(chunk);
				if (event.type === EventType.TEXT_MESSAGE_END) {
					expect(await readEventTypes("run-1")).toContain(
						"assistant_message_completed",
					);
				}
				if (event.type === EventType.RUN_FINISHED) {
					expect((await readRun("run-1"))?.status).toBe("done");
				}
				observed.push(event);
			}
		})();

		continueProcessor.resolve();
		await worker.drain();
		await consume;

		expect(observed).toEqual([
			{ type: EventType.RUN_STARTED, threadId: "conv-1", runId: "run-1" },
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: "assistant-1",
				role: "assistant",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "assistant-1",
				delta: "hello",
			},
			{ type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
			{ type: EventType.RUN_FINISHED, threadId: "conv-1", runId: "run-1" },
		]);
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("continues durable execution after a mid-text Live Stream write fails", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ eventType }) =>
					eventType === EventType.TEXT_MESSAGE_CONTENT,
			},
		});
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_START,
					messageId: "assistant-1",
					role: "assistant",
				});
				await ctx.appendLiveEvent({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "assistant-1",
					delta: "still durable",
				});
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: {
						messageId: "assistant-1",
						text: "still durable",
					},
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("keeps committing Tool events after Live Stream publication fails", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ eventType }) =>
					eventType === EventType.TOOL_CALL_START,
			},
		});
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			async (ctx) => {
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "assistant-1", text: "" },
				});
				await ctx.appendModelContents([
					{
						kind: "tool_call_started",
						payload: {
							toolCallId: "tool-1",
							toolCallName: "Bash",
							parentMessageId: "assistant-1",
						},
					},
					{
						kind: "tool_call_args",
						payload: { toolCallId: "tool-1", delta: '{"command":"pwd"}' },
					},
					{
						kind: "tool_call_completed",
						payload: { toolCallId: "tool-1" },
					},
				]);
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_START,
					toolCallId: "tool-1",
					toolCallName: "Bash",
					parentMessageId: "assistant-1",
				});
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_ARGS,
					toolCallId: "tool-1",
					delta: '{"command":"pwd"}',
				});
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_END,
					toolCallId: "tool-1",
				});
				await ctx.appendModelContent({
					kind: "tool_call_result",
					payload: {
						messageId: "tool-result-1",
						toolCallId: "tool-1",
						content: '{"exitCode":0}',
						isError: false,
					},
				});
				await ctx.appendLiveEvent({
					type: EventType.TOOL_CALL_RESULT,
					messageId: "tool-result-1",
					toolCallId: "tool-1",
					content: '{"exitCode":0}',
					role: "tool",
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
			"run_done",
		]);
	});

	it("marks the Live Stream failed after durable terminalization without changing the Outcome", async () => {
		const liveStreamRelay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ terminal }) => terminal,
			},
		});
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor, liveStreamRelay);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect(await readRun("run-1")).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});

	it("ends a synthetic run as done with one durable Assistant message", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readEventTypes("run-1")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
		const [message] = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.type, "assistant_message_completed"));
		expect(message?.payload).toEqual({
			messageId: "message-run-1",
			text: "synthetic run-1",
		});
	});

	it("logs a failed run but persists only a generic client message", async () => {
		const worker = buildWorker(1);
		const errors: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			...silentLogger,
			error(event) {
				errors.push(event);
			},
		};
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: async () => {
				throw new Error("provider leaked a secret detail");
			},
			heartbeatIntervalMs: 15_000,
			logger,
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
			"Run failed",
		);
		expect(JSON.stringify(event?.payload)).not.toContain("secret detail");
		expect(errors).toContainEqual({
			message: "run failed",
			workerId: "worker-1",
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
			error: "provider leaked a secret detail",
		});
	});

	it("terminalizes as interrupted when interruption is observed mid-processing", async () => {
		const worker = buildWorker(1);
		const published: unknown[] = [];
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		const processorStarted = deferred();
		// A processor that runs until the run is aborted, without appending.
		const loop = buildLoop(
			worker,
			async (ctx) => {
				processorStarted.resolve();
				await new Promise<void>((resolve) => {
					if (ctx.signal.aborted) return resolve();
					ctx.signal.addEventListener("abort", () => resolve(), { once: true });
				});
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor now blocking on abort)
		await processorStarted.promise;
		const attached = await liveStreamRelay.attach(
			"run-1",
			new AbortController().signal,
		);
		if (attached.outcome !== "attached") throw new Error("expected attachment");
		const consume = (async () => {
			for await (const chunk of attached.events) {
				published.push(decodeAgUiLiveStreamEvent(chunk));
			}
		})();

		// User requests interruption while the run is executing.
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested", interruptRequestedAt: sql`now()` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // status observation sees interrupt_requested → aborts the run
		await worker.drain();
		await consume;

		expect(await readRun("run-1")).toMatchObject({
			status: "interrupted",
			liveStreamFailedAt: null,
		});
		expect(await readEventTypes("run-1")).toEqual(["run_interrupted"]);
		expect(published).toEqual([
			{ type: EventType.RUN_STARTED, threadId: "conv-1", runId: "run-1" },
			{ type: "RUN_INTERRUPTED", threadId: "conv-1", runId: "run-1" },
		]);
	});
});

describe("RunLoop — agent session pointer", () => {
	it("does not establish the first pointer without main-session evidence", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			return {
				disposition: "completed",
				streamMetadata: {
					mirrorErrorObserved: false,
					mirroredMainSessionId: null,
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		expect(await readRuntime("conv-1")).toMatchObject({
			agentSessionId: null,
		});
	});

	it("establishes the first pointer after a successful main-session append", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			// The runtime row is created while the run is owned (as E2B provisioning
			// will), so the fenced pointer advance in `finish()` has a row to update.
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			return {
				disposition: "completed",
				streamMetadata: {
					mirrorErrorObserved: false,
					mirroredMainSessionId: "session-abc",
				},
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

	it.each([
		["without main-session evidence", null, null, false],
		[
			"with main-session evidence",
			"session-interrupted",
			"session-interrupted",
			false,
		],
		["with unreliable mirror evidence", "session-unreliable", null, true],
	] as const)("terminalizes an interrupted first Run %s", async (_name, mirroredMainSessionId, expectedPointer, mirrorErrorObserved) => {
		const worker = buildWorker(1);
		const processorStarted = deferred();
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			processorStarted.resolve();
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve();
				ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return {
				disposition: "stopped",
				streamMetadata: {
					mirrorErrorObserved,
					mirroredMainSessionId,
				},
			};
		});
		await queueRun("run-1", "conv-1");
		await loop.tick();
		await processorStarted.promise;
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect(await readRuntime("conv-1")).toMatchObject({
			agentSessionId: expectedPointer,
		});
		expect(await readEventTypes("run-1")).toEqual(["run_interrupted"]);
	});

	it("reconciles a completed turn to interrupted from the refused done fence", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			// The durable request lands after the last heartbeat, so loop-local
			// interruption state stays false: the only thing that can tell the loop
			// to follow up with `interrupted` is the rejection the `done` fence
			// returns, which names the Run's actual status.
			await requestRunInterruptionTx(tdb.db, {
				runId: ctx.run.runId,
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
			});
			return {
				disposition: "completed",
				streamMetadata: {
					mirrorErrorObserved: false,
					mirroredMainSessionId: "session-reconciled-done",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect(await readEventTypes("run-1")).toEqual(["run_interrupted"]);
		expect(await readRuntime("conv-1")).toMatchObject({
			agentSessionId: "session-reconciled-done",
		});
	});

	it("leaves a Run to Reclamation instead of chasing interrupted after the lease is gone", async () => {
		const worker = buildWorker(1);
		const processorStarted = deferred();
		const gate = deferred();
		const loop = buildLoop(worker, async () => {
			processorStarted.resolve();
			await gate.promise;
			return { disposition: "completed" };
		});
		await queueRun("run-1", "conv-1");
		await loop.tick();
		await processorStarted.promise;
		// Lapse Ownership without ticking, so the loop never observes the loss and
		// reaches `finish()` believing it still owns the Run.
		await lapseOwnershipLease("conv-1");

		gate.resolve();
		await worker.drain();

		// A lost lease is final: Reclamation owns the Run, so neither `done` nor a
		// speculative `interrupted` may be written over it.
		expect((await readRun("run-1"))?.status).toBe("running");
		expect(await readEventTypes("run-1")).toEqual([]);

		// The Run is left intact for Reclamation, which records stale_worker.
		await loop.tick();
		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readEventTypes("run-1")).toEqual(["run_error"]);
	});

	it("keeps qualifying evidence when error reconciliation loses to interruption", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			// The durable request lands after the last heartbeat, so loop-local
			// interruption state remains false and the error CAS must reconcile.
			await requestRunInterruptionTx(tdb.db, {
				runId: ctx.run.runId,
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
			});
			return {
				disposition: "stopped",
				streamMetadata: {
					mirrorErrorObserved: false,
					mirroredMainSessionId: "session-reconciled",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect(await readRuntime("conv-1")).toMatchObject({
			agentSessionId: "session-reconciled",
		});
		expect(await readEventTypes("run-1")).toEqual(["run_interrupted"]);
	});

	it("drops unreliable evidence when mirror-error reconciliation loses to interruption", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			await requestRunInterruptionTx(tdb.db, {
				runId: ctx.run.runId,
				userId: ctx.run.userId,
				conversationId: ctx.run.conversationId,
			});
			return {
				disposition: "stopped",
				streamMetadata: {
					mirrorErrorObserved: true,
					mirroredMainSessionId: "session-unreliable",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("interrupted");
		expect(await readRuntime("conv-1")).toMatchObject({ agentSessionId: null });
		expect(await readEventTypes("run-1")).toEqual(["run_interrupted"]);
	});

	it("keeps interruption-only continuity out of a plain error Outcome", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			return {
				disposition: "stopped",
				streamMetadata: {
					mirrorErrorObserved: false,
					mirroredMainSessionId: "session-interruption-fallback",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readRuntime("conv-1")).toMatchObject({ agentSessionId: null });
		expect(await readEventTypes("run-1")).toEqual(["run_error"]);
	});

	it("terminalizes error without establishing a pointer after a mirror error stop", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			return {
				disposition: "stopped",
				streamMetadata: {
					mirrorErrorObserved: true,
					mirroredMainSessionId: "session-first",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readRuntime("conv-1")).toMatchObject({ agentSessionId: null });
	});

	it("defensively rejects a completed processor result that reports a mirror error", async () => {
		const worker = buildWorker(1);
		const loop = buildLoop(worker, async (ctx) => {
			await createConversationRuntimeTx(tdb.db, ctx.owner);
			return {
				disposition: "completed",
				streamMetadata: {
					mirrorErrorObserved: true,
					mirroredMainSessionId: "session-first",
				},
			};
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readRuntime("conv-1")).toMatchObject({ agentSessionId: null });
	});
});

describe("RunLoop — shutdown", () => {
	it("signals shutdown after a terminal status rejects an in-flight append", async () => {
		const worker = buildWorker(1);
		const processorStarted = deferred();
		const attemptAppend = deferred();
		const appendRejected = deferred();
		const shutdownObserved = deferred();
		let owner: Parameters<RunProcessor>[0]["owner"] | undefined;
		const loop = buildLoop(worker, async (ctx) => {
			owner = ctx.owner;
			processorStarted.resolve();
			await attemptAppend.promise;
			try {
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "message-late", text: "too late" },
				});
			} catch {
				appendRejected.resolve();
				await new Promise<void>((resolve) => {
					if (ctx.shutdownSignal.aborted) return resolve();
					ctx.shutdownSignal.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				shutdownObserved.resolve();
			}
		});
		await queueRun("run-1", "conv-1");
		await startDrain(loop);
		await processorStarted.promise;
		if (!owner) throw new Error("processor did not expose its Run owner");
		expect(
			await transitionRunTerminalTx(tdb.db, { owner, status: "done" }),
		).toMatchObject({ outcome: "committed" });

		attemptAppend.resolve();
		await appendRejected.promise;
		await loop.stop();

		await shutdownObserved.promise;
		expect((await readRun("run-1"))?.status).toBe("done");
	});

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

describe("RunLoop — Conversation Reclamation", () => {
	it("reclaims every lapsed Conversation in one tick", async () => {
		await claimRun("run-a", "conv-a", "vanished-a");
		await claimRun("run-b", "conv-b", "vanished-b");
		await lapseOwnershipLease("conv-a");
		await lapseOwnershipLease("conv-b");
		const loop = buildLoop(buildWorker(1), appendMessageProcessor);

		expect(await loop.tick()).toBe(0);
		expect((await readRun("run-a"))?.status).toBe("error");
		expect((await readRun("run-b"))?.status).toBe("error");
	});

	it("claims an old queued Run immediately after reclaiming its lapsed Conversation", async () => {
		await claimRun("run-running", "conv-1", "vanished-worker");
		await queueRun("run-queued", "conv-1");
		await ageRunsPastQueueTimeout("run-queued");
		await lapseOwnershipLease("conv-1");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		expect(await loop.tick()).toBe(1);
		await worker.drain();

		expect((await readRun("run-running"))?.status).toBe("error");
		expect((await readRun("run-queued"))?.status).toBe("done");
	});

	it("observes the degradation marker and duration created by Reclamation", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await lapseOwnershipLease("conv-1");
		const metrics: Record<string, unknown>[] = [];
		const telemetry: LiveStreamTelemetry = {
			record(operation, result, options) {
				metrics.push({ operation, result, ...options });
			},
		};
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			appendMessageProcessor,
			undefined,
			telemetry,
		);

		await loop.tick();

		expect(metrics).toEqual([
			{
				operation: "degradation",
				result: "started",
				reason: "stale_worker",
			},
			{
				operation: "degradation",
				result: "ended",
				reason: "stale_worker",
				durationMs: expect.any(Number),
			},
		]);
	});

	it("ends an existing degradation during Reclamation without duplicating its start", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await tdb.db
			.update(runs)
			.set({ liveStreamFailedAt: new Date(Date.now() - 1_000) })
			.where(eq(runs.runId, "run-stale"));
		await lapseOwnershipLease("conv-1");
		const metrics: Record<string, unknown>[] = [];
		const telemetry: LiveStreamTelemetry = {
			record(operation, result, options) {
				metrics.push({ operation, result, ...options });
			},
		};
		const worker = buildWorker(1);
		const loop = buildLoop(
			worker,
			appendMessageProcessor,
			undefined,
			telemetry,
		);

		await loop.tick();

		expect(metrics).toEqual([
			{
				operation: "degradation",
				result: "ended",
				reason: "stale_worker",
				durationMs: expect.any(Number),
			},
		]);
	});

	it("terminalizes a running Run after its Ownership lease lapses", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await lapseOwnershipLease("conv-1");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		const claimed = await loop.tick();
		await worker.drain();

		expect(claimed).toBe(0);
		expect((await readRun("run-stale"))?.status).toBe("error");
		expect(await readEventTypes("run-stale")).toEqual(["run_error"]);
	});

	it("terminalizes interrupt-requested after its Ownership lease lapses", async () => {
		await claimRun("run-stale", "conv-1", "stale-worker");
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-stale",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await lapseOwnershipLease("conv-1");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-stale"))?.status).toBe("interrupted");
		expect(await readEventTypes("run-stale")).toEqual(["run_interrupted"]);
	});

	it("rejects the former owner's appends after Reclamation terminalizes the Run", async () => {
		const lapsedOwner = await claimRun("run-stale", "conv-1", "stale-worker");
		await lapseOwnershipLease("conv-1");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		await loop.tick();

		expect(
			await appendRunEventTx(tdb.db, {
				owner: {
					...lapsedOwner,
					runId: "run-stale",
					workerId: "stale-worker",
				},
				type: "assistant_message_completed",
				payload: { messageId: "message-too-late", text: "too late" },
				appendClass: "model",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
		expect(await readEventTypes("run-stale")).toEqual(["run_error"]);
	});

	it("does not double-terminalize when Reclamation beats an active processor", async () => {
		const worker = buildWorker(1);
		const gate = deferred();
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		const loop = buildLoop(
			worker,
			async () => {
				await gate.promise;
			},
			liveStreamRelay,
		);
		await queueRun("run-1", "conv-1");
		await loop.tick(); // claim + dispatch (processor blocks)
		await lapseOwnershipLease("conv-1");

		await loop.tick(); // reclaims the Conversation, then observes lost ownership
		gate.resolve();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("error");
		expect(await readEventTypes("run-1")).toEqual(["run_error"]);
		expect(
			(await liveStreamRelay.attach("run-1", new AbortController().signal))
				.outcome,
		).toBe("no_producer");
		await liveStreamRelay.close();
	});
});

describe("RunLoop — unowned queue timeout", () => {
	it("expires an old queued Run without claiming its Conversation", async () => {
		await queueRun("run-old", "conv-1");
		await ageRunsPastQueueTimeout("run-old");
		const worker = buildWorker(1);
		const loop = buildLoop(worker, appendMessageProcessor);

		const claimed = await loop.tick();

		expect(claimed).toBe(0);
		expect((await readRun("run-old"))?.status).toBe("error");
		expect(await readEventTypes("run-old")).toEqual(["run_error"]);
	});
});

describe("RunLoop — model-content append", () => {
	it("surfaces the durable sequence numbers assigned to single and batched content", async () => {
		const worker = buildWorker(1);
		const surfacedSequences: number[] = [];
		const loop = buildLoop(worker, async (ctx) => {
			surfacedSequences.push(
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "message-1", text: "running a command" },
				}),
			);
			surfacedSequences.push(
				...(await ctx.appendModelContents([
					{
						kind: "tool_call_started",
						payload: {
							toolCallId: "tool-1",
							toolCallName: "Bash",
							parentMessageId: "message-1",
						},
					},
					{
						kind: "tool_call_args",
						payload: { toolCallId: "tool-1", delta: '{"command":"pwd"}' },
					},
					{
						kind: "tool_call_completed",
						payload: { toolCallId: "tool-1" },
					},
				])),
			);
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		const durableSequences = await tdb.db
			.select({ seq: runEvents.seq })
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"))
			.orderBy(runEvents.seq);
		expect(surfacedSequences).toEqual(
			durableSequences.slice(0, -1).map(({ seq }) => seq),
		);
		expect((await readRun("run-1"))?.status).toBe("done");
	});

	it("maps each model-content kind to its durable event type", async () => {
		const worker = buildWorker(1);
		// One turn recording an Assistant message, a Tool invocation, and its result;
		// the loop, not the processor, owns the kind→type mapping.
		const loop = buildLoop(worker, async (ctx) => {
			await ctx.appendModelContent({
				kind: "assistant_message",
				payload: { messageId: "message-1", text: "listed" },
			});
			await ctx.appendModelContent({
				kind: "ui_payload",
				payload: {
					messageId: "message-1",
					version: 1,
					payload: {
						component: "diagram",
						props: { source: "flowchart LR\nA --> B" },
					},
				},
			});
			await ctx.appendModelContent({
				kind: "tool_call_started",
				payload: {
					toolCallId: "tool-1",
					toolCallName: "Bash",
					parentMessageId: "message-1",
				},
			});
			await ctx.appendModelContent({
				kind: "tool_call_args",
				payload: { toolCallId: "tool-1", delta: '{"command":"ls"}' },
			});
			await ctx.appendModelContent({
				kind: "tool_call_completed",
				payload: { toolCallId: "tool-1" },
			});
			await ctx.appendModelContent({
				kind: "tool_call_result",
				payload: {
					messageId: "tool-result-1",
					toolCallId: "tool-1",
					content: '{"exitCode":0}',
					isError: false,
				},
			});
		});
		await queueRun("run-1", "conv-1");

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		const events = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"))
			.orderBy(runEvents.seq);
		expect(events.map((e) => e.type)).toEqual([
			"assistant_message_completed",
			"ui_payload",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
			"run_done",
		]);
		expect(events[0]?.payload).toEqual({
			messageId: "message-1",
			text: "listed",
		});
		expect(events[1]?.payload).toEqual({
			messageId: "message-1",
			version: 1,
			payload: {
				component: "diagram",
				props: { source: "flowchart LR\nA --> B" },
			},
		});
		expect(events[2]?.payload).toEqual({
			toolCallId: "tool-1",
			toolCallName: "Bash",
			parentMessageId: "message-1",
		});
	});
});

describe("RunLoop — synthetic end-to-end smoke", () => {
	it("claims a queued run, commits an Assistant message, and ends it as done", async () => {
		const worker = buildWorker(2);
		const loop = buildLoop(worker, appendMessageProcessor);
		// A conversation queued a run (chat-api's admission side, mirrored here).
		await queueRun("run-smoke", "conv-smoke");

		const claimed = await loop.tick();
		await worker.drain();

		expect(claimed).toBe(1);
		const row = await readRun("run-smoke");
		expect(row?.status).toBe("done");
		expect(row?.executedByWorkerId).toBe("worker-1");
		// The durable event log carries the complete Assistant message ahead of the
		// terminal frame.
		expect(await readEventTypes("run-smoke")).toEqual([
			"assistant_message_completed",
			"run_done",
		]);
	});
});

/** Poll until `condition` holds; fail fast with a named timeout otherwise. */
async function waitUntil(
	condition: () => Promise<boolean> | boolean,
	label: string,
	timeoutMs = 4_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await Bun.sleep(5);
	}
}

/** A test doorbell: the test rings it and observes (un)subscription. */
function buildDoorbell() {
	let onRing: (() => void) | null = null;
	let unsubscribed = false;
	return {
		doorbell: {
			subscribe(callback: () => void): () => void {
				onRing = callback;
				return () => {
					unsubscribed = true;
					onRing = null;
				};
			},
		},
		ring: () => onRing?.(),
		get unsubscribed() {
			return unsubscribed;
		},
	};
}

describe("RunLoop — doorbell", () => {
	it("claims a queued run when the doorbell rings, without waiting for the timer", async () => {
		const worker = buildWorker(1);
		const bell = buildDoorbell();
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: appendMessageProcessor,
			// The timer cannot fire within the test window: only start()'s
			// immediate tick and the doorbell can claim.
			heartbeatIntervalMs: 3_600_000,
			logger: silentLogger,
			doorbell: bell.doorbell,
		});
		// The sentinel absorbs the immediate start() tick; with capacity 1 its
		// claim loop exits before another run could be claimed.
		await queueRun("run-sentinel", "conv-sentinel");
		loop.start();
		await waitUntil(
			async () => (await readRun("run-sentinel"))?.status === "done",
			"sentinel run to finish",
		);

		// Queued after every scheduled tick has completed: only a ring claims it.
		await queueRun("run-target", "conv-target");
		bell.ring();

		await waitUntil(
			async () => (await readRun("run-target"))?.status === "done",
			"doorbell ring to claim and finish the target run",
		);
		await loop.stop();
	});

	it("unsubscribes from the doorbell on stop, so a late ring claims nothing", async () => {
		const worker = buildWorker(1);
		const bell = buildDoorbell();
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: appendMessageProcessor,
			heartbeatIntervalMs: 3_600_000,
			logger: silentLogger,
			doorbell: bell.doorbell,
		});
		loop.start();
		await loop.stop();

		expect(bell.unsubscribed).toBe(true);
		await queueRun("run-late", "conv-late");
		bell.ring();
		await Bun.sleep(20);
		expect((await readRun("run-late"))?.status).toBe("queued");
	});
});
