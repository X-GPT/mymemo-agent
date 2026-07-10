import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createQueuedRunTx } from "@mymemo/agent-db/run-store";
import { runEvents, runs } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import { RunLoop } from "../run-loop";
import { Worker } from "../worker";
import type { SupervisedQuery } from "./agent-stream";
import { createSdkRunProcessor, type StartRunQuery } from "./run-processor";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
});

function assistantMessage(text: string): SDKMessage {
	return {
		type: "assistant",
		message: { content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

/** A query that yields the messages then ends; a `throw` step rejects the stream. */
function scriptedQuery(
	steps: ({ text: string } | { throw: unknown })[],
): SupervisedQuery {
	return {
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			for (const step of steps) {
				if ("throw" in step) throw step.throw;
				yield assistantMessage(step.text);
			}
		},
	};
}

/**
 * A query that yields one message then blocks until the run is aborted, then
 * emits one more (ignored) message and ends — as a real interrupt would. Records
 * interrupt calls so the test can assert the supervisor interrupted the query.
 */
function cancelableQuery(
	signal: AbortSignal,
	firstText: string,
): SupervisedQuery & { interrupts: number } {
	const q = {
		interrupts: 0,
		async interrupt() {
			q.interrupts++;
		},
		async *[Symbol.asyncIterator]() {
			yield assistantMessage(firstText);
			await new Promise<void>((resolve) => {
				if (signal.aborted) return resolve();
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			yield assistantMessage("content-after-cancel");
		},
	};
	return q;
}

function buildLoop(worker: Worker, startRunQuery: StartRunQuery) {
	return new RunLoop({
		db: tdb.db,
		worker,
		processor: createSdkRunProcessor({ startRunQuery, logger: silentLogger }),
		heartbeatIntervalMs: 15_000,
		logger: silentLogger,
	});
}

function buildWorker() {
	return new Worker({
		workerId: "worker-1",
		maxConcurrentRuns: 1,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
}

async function readRun(runId: string) {
	const [row] = await tdb.db.select().from(runs).where(eq(runs.runId, runId));
	return row;
}

async function readEvents(runId: string) {
	const rows = await tdb.db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(runEvents.seq);
	return rows;
}

describe("createSdkRunProcessor — through the run loop", () => {
	it("appends assistant text as run events and completes the run as done", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async () =>
			scriptedQuery([{ text: "Hello " }, { text: "there." }]),
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("done");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual([
			"assistant_text",
			"assistant_text",
			"run_done",
		]);
		expect(
			events.slice(0, 2).map((e) => (e.payload as { text: string }).text),
		).toEqual(["Hello ", "there."]);
	});

	it("passes the claimed run and abort signal to startRunQuery", async () => {
		const worker = buildWorker();
		let seenRunId: string | undefined;
		let sawSignal = false;
		const loop = buildLoop(worker, async (run, signal) => {
			seenRunId = run.runId;
			sawSignal = signal instanceof AbortSignal;
			return scriptedQuery([{ text: "ok" }]);
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		expect(seenRunId).toBe("run-1");
		expect(sawSignal).toBe(true);
	});

	it("terminalizes an SDK failure with the generic client message", async () => {
		const worker = buildWorker();
		const loop = buildLoop(worker, async () =>
			scriptedQuery([
				{ text: "partial" },
				{ throw: new Error("model exploded") },
			]),
		);
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		const run = await readRun("run-1");
		expect(run?.status).toBe("error");
		const events = await readEvents("run-1");
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("run_error");
		expect((terminal?.payload as { message: string }).message).toBe(
			"Run failed",
		);
		expect(JSON.stringify(terminal?.payload)).not.toContain("model exploded");
	});

	it("ignores content after cancel_requested and terminalizes as canceled", async () => {
		const worker = buildWorker();
		let query: (SupervisedQuery & { interrupts: number }) | undefined;
		const loop = buildLoop(worker, async (_run, signal) => {
			query = cancelableQuery(signal, "before cancel");
			return query;
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick(); // claim + dispatch; processor streams "before cancel"

		// User cancels the running run.
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested", cancelRequestedAt: sql`now()` })
			.where(eq(runs.runId, "run-1"));

		await loop.tick(); // heartbeat observes cancel → aborts the run's signal
		await worker.drain();

		expect((await readRun("run-1"))?.status).toBe("canceled");
		const types = (await readEvents("run-1")).map((e) => e.type);
		// The single pre-cancel text delta survived; post-cancel content did not.
		expect(types).toEqual(["assistant_text", "run_canceled"]);
		expect(query?.interrupts).toBeGreaterThanOrEqual(1);
	});
});
