import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { claimConversationTx } from "@mymemo/agent-db/conversation-ownership";
import {
	requestRunInterruptionTx,
	startClaimedRunTx,
} from "@mymemo/agent-db/run-store";
import { conversations, runs } from "@mymemo/agent-db/schema";
import {
	createTestDatabase,
	seedQueuedRun,
	type TestDb,
} from "@mymemo/agent-db/testing";
import { createInMemoryLiveStreamRelay } from "@mymemo/live-text";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "./logger";
import { createRunServing } from "./run-serving";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(runs);
	await tdb.db.delete(conversations);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function startRun() {
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conv-1",
		scope: "general",
	});
	await seedQueuedRun(tdb.db, {
		runId: "run-1",
		userId: "user-1",
		conversationId: "conv-1",
	});
	const claim = await claimConversationTx(tdb.db, { workerId: "worker-1" });
	if (!claim) throw new Error("test setup did not Claim the Conversation");
	const started = await startClaimedRunTx(tdb.db, {
		owner: claim,
		runId: "run-1",
		workerId: "worker-1",
	});
	if (started.outcome !== "started") {
		throw new Error("test setup did not start the Run");
	}
	return { claim, run: started.run };
}

describe("serveStartedRun", () => {
	it("serves an already-running Run through its terminal Outcome", async () => {
		const { claim, run } = await startRun();
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "message-1", text: "hello" },
				});
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			heartbeatIntervalMs: 15_000,
			logger: silentLogger,
		});

		const result = await serving.serveStartedRun({
			run,
			owner: { ...claim, runId: run.runId, workerId: "worker-1" },
			shutdownSignal: new AbortController().signal,
		});

		expect(result).toEqual({ type: "terminal", status: "done" });
		const [stored] = await tdb.db
			.select({ status: runs.status })
			.from(runs)
			.where(eq(runs.runId, run.runId));
		expect(stored?.status).toBe("done");
	});

	it("returns ownership loss without terminalizing the Run", async () => {
		const { claim, run } = await startRun();
		const gate = deferred();
		const serving = createRunServing({
			db: tdb.db,
			processor: async () => {
				await gate.promise;
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			heartbeatIntervalMs: 5,
			logger: silentLogger,
		});
		const resultPromise = serving.serveStartedRun({
			run,
			owner: { ...claim, runId: run.runId, workerId: "worker-1" },
			shutdownSignal: new AbortController().signal,
		});
		await tdb.db
			.update(conversations)
			.set({
				epoch: sql`${conversations.epoch} + 1`,
				ownerWorkerId: "worker-2",
				ownerUntil: sql`now() + interval '60 seconds'`,
			})
			.where(eq(conversations.conversationId, run.conversationId));

		gate.resolve();

		expect(await resultPromise).toEqual({
			type: "ownership_lost",
			reason: "lease",
		});
		const [stored] = await tdb.db
			.select({ status: runs.status })
			.from(runs)
			.where(eq(runs.runId, run.runId));
		expect(stored?.status).toBe("running");
	});

	it("lets durable interruption win over processor failure", async () => {
		const { claim, run } = await startRun();
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				await new Promise<void>((resolve) => {
					if (ctx.signal.aborted) return resolve();
					ctx.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("processor stopped");
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			heartbeatIntervalMs: 5,
			logger: silentLogger,
		});
		const resultPromise = serving.serveStartedRun({
			run,
			owner: { ...claim, runId: run.runId, workerId: "worker-1" },
			shutdownSignal: new AbortController().signal,
		});
		await requestRunInterruptionTx(tdb.db, {
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
		});

		expect(await resultPromise).toEqual({
			type: "terminal",
			status: "interrupted",
		});
	});

	it("returns shutdown after terminalizing active work as error", async () => {
		const { claim, run } = await startRun();
		const shutdownController = new AbortController();
		const processorGate = deferred();
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				await new Promise<void>((resolve) => {
					if (ctx.signal.aborted) return resolve();
					ctx.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				await processorGate.promise;
				throw new Error("runtime stopped");
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			heartbeatIntervalMs: 5,
			logger: silentLogger,
		});
		const resultPromise = serving.serveStartedRun({
			run,
			owner: { ...claim, runId: run.runId, workerId: "worker-1" },
			shutdownSignal: shutdownController.signal,
		});
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, run.conversationId));

		shutdownController.abort();
		await Bun.sleep(20);
		const [ownership] = await tdb.db
			.select({ ownerUntil: conversations.ownerUntil })
			.from(conversations)
			.where(eq(conversations.conversationId, run.conversationId));
		expect(ownership?.ownerUntil?.getTime()).toBeLessThan(Date.now() + 30_000);
		processorGate.resolve();

		expect(await resultPromise).toEqual({
			type: "shutdown",
			status: "error",
		});
	});
});
