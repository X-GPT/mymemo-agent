import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { recordArtifactObjectsTx } from "@mymemo/agent-db/artifact-store";
import {
	loadExecutingRunTx,
	requestRunInterruptionTx,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";
import { createConversationRuntimeTx } from "@mymemo/agent-db/runtime-store";
import {
	conversationArtifacts,
	conversationRuntime,
	conversations,
	runs,
} from "@mymemo/agent-db/schema";
import {
	acquireQueuedRunForTest,
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
		executionRuntime: "agentcore",
	});
	await seedQueuedRun(tdb.db, {
		runId: "run-1",
		userId: "user-1",
		conversationId: "conv-1",
	});
	const acquired = await acquireQueuedRunForTest(tdb.db, {
		workerId: "worker-1",
	});
	if (!acquired) throw new Error("test setup did not acquire the Conversation");
	const run = await loadExecutingRunTx(tdb.db, {
		...acquired,
		runId: "run-1",
	});
	if (!run) throw new Error("test setup did not start the Run");
	return { acquired, run };
}

describe("serveStartedRun", () => {
	it("serves an already-running Run through its terminal Outcome", async () => {
		const { acquired, run } = await startRun();
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "message-1", text: "hello" },
				});
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			logger: silentLogger,
		});

		const result = await serving.serveStartedRun({
			run,
			owner: { ...acquired, runId: run.runId, workerId: "worker-1" },
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
		const { acquired, run } = await startRun();
		const gate = deferred();
		const serving = createRunServing({
			db: tdb.db,
			processor: async () => {
				await gate.promise;
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			logger: silentLogger,
		});
		const resultPromise = serving.serveStartedRun({
			run,
			owner: { ...acquired, runId: run.runId, workerId: "worker-1" },
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
		await serving.heartbeat();

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

	it("abandons a Run that already reached an Outcome without halting its Conversation", async () => {
		const { acquired, run } = await startRun();
		const processorStarted = deferred();
		const ownershipStopped = deferred();
		const releaseProcessor = deferred();
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				if (ctx.ownershipLostSignal.aborted) ownershipStopped.resolve();
				else {
					ctx.ownershipLostSignal.addEventListener(
						"abort",
						() => ownershipStopped.resolve(),
						{ once: true },
					);
				}
				processorStarted.resolve();
				await ownershipStopped.promise;
				await releaseProcessor.promise;
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			logger: silentLogger,
		});
		const owner = { ...acquired, runId: run.runId, workerId: "worker-1" };
		const resultPromise = serving.serveStartedRun({
			run,
			owner,
			shutdownSignal: new AbortController().signal,
		});
		await processorStarted.promise;

		expect(
			await transitionRunTerminalTx(tdb.db, { owner, status: "done" }),
		).toMatchObject({ outcome: "committed" });
		await serving.heartbeat();
		await ownershipStopped.promise;
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, run.conversationId));
		await serving.heartbeat();
		const [ownership] = await tdb.db
			.select({ ownerUntil: conversations.ownerUntil })
			.from(conversations)
			.where(eq(conversations.conversationId, run.conversationId));
		expect(ownership?.ownerUntil?.getTime()).toBeLessThan(Date.now() + 30_000);

		releaseProcessor.resolve();
		expect(await resultPromise).toEqual({ type: "terminal", status: null });
	});

	it("keeps a status-rejected Run attached until the next heartbeat", async () => {
		const { acquired, run } = await startRun();
		const processorStarted = deferred();
		const attemptAppend = deferred();
		const appendRejected = deferred();
		const releaseProcessor = deferred();
		let detachments = 0;
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				processorStarted.resolve();
				await attemptAppend.promise;
				try {
					await ctx.appendModelContent({
						kind: "assistant_message",
						payload: { messageId: "message-late", text: "too late" },
					});
				} catch {
					appendRejected.resolve();
					await releaseProcessor.promise;
				}
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			logger: silentLogger,
		});
		const owner = { ...acquired, runId: run.runId, workerId: "worker-1" };
		const resultPromise = serving.serveStartedRun({
			run,
			owner,
			shutdownSignal: new AbortController().signal,
			onDetached: (event) => {
				if (event.type === "run_detached") detachments++;
			},
		});
		await processorStarted.promise;
		expect(
			await transitionRunTerminalTx(tdb.db, { owner, status: "done" }),
		).toMatchObject({ outcome: "committed" });

		attemptAppend.resolve();
		await appendRejected.promise;
		expect(detachments).toBe(0);
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, run.conversationId));
		await serving.heartbeat();
		expect(detachments).toBe(1);
		const [ownership] = await tdb.db
			.select({ ownerUntil: conversations.ownerUntil })
			.from(conversations)
			.where(eq(conversations.conversationId, run.conversationId));
		expect(ownership?.ownerUntil?.getTime()).toBeGreaterThan(
			Date.now() + 30_000,
		);

		releaseProcessor.resolve();
		expect(await resultPromise).toEqual({ type: "terminal", status: null });
	});

	it("lets durable interruption win over processor failure", async () => {
		const { acquired, run } = await startRun();
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
			logger: silentLogger,
		});
		const resultPromise = serving.serveStartedRun({
			run,
			owner: { ...acquired, runId: run.runId, workerId: "worker-1" },
			shutdownSignal: new AbortController().signal,
		});
		await requestRunInterruptionTx(tdb.db, {
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
		});
		await serving.heartbeat();

		expect(await resultPromise).toEqual({
			type: "terminal",
			status: "interrupted",
		});
	});

	it("returns shutdown after terminalizing active work as error", async () => {
		const { acquired, run } = await startRun();
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
			logger: silentLogger,
		});
		const resultPromise = serving.serveStartedRun({
			run,
			owner: { ...acquired, runId: run.runId, workerId: "worker-1" },
			shutdownSignal: shutdownController.signal,
		});
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, run.conversationId));

		shutdownController.abort();
		await serving.heartbeat();
		const [ownership] = await tdb.db
			.select({ ownerUntil: conversations.ownerUntil })
			.from(conversations)
			.where(eq(conversations.conversationId, run.conversationId));
		expect(ownership?.ownerUntil?.getTime()).toBeGreaterThan(
			Date.now() + 30_000,
		);
		processorGate.resolve();

		expect(await resultPromise).toEqual({
			type: "shutdown",
			status: "error",
		});
	});

	it("lets durable interruption committed during shutdown win", async () => {
		const { acquired, run } = await startRun();
		const shutdownController = new AbortController();
		const processorStopped = deferred();
		const releaseProcessor = deferred();
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				await new Promise<void>((resolve) => {
					if (ctx.signal.aborted) return resolve();
					ctx.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				processorStopped.resolve();
				await releaseProcessor.promise;
				throw new Error("runtime stopped");
			},
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			logger: silentLogger,
		});
		const resultPromise = serving.serveStartedRun({
			run,
			owner: { ...acquired, runId: run.runId, workerId: "worker-1" },
			shutdownSignal: shutdownController.signal,
		});

		shutdownController.abort();
		await processorStopped.promise;
		await requestRunInterruptionTx(tdb.db, {
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
		});
		releaseProcessor.resolve();

		expect(await resultPromise).toEqual({
			type: "shutdown",
			status: "interrupted",
		});
	});

	it("degrades Live Stream publication without changing durable execution", async () => {
		const { acquired, run } = await startRun();
		const liveStreamRelay = createInMemoryLiveStreamRelay();
		await liveStreamRelay.close();
		const serving = createRunServing({
			db: tdb.db,
			processor: async (ctx) => {
				await ctx.appendModelContent({
					kind: "assistant_message",
					payload: { messageId: "message-1", text: "still durable" },
				});
			},
			liveStreamRelay,
			logger: silentLogger,
		});

		expect(
			await serving.serveStartedRun({
				run,
				owner: { ...acquired, runId: run.runId, workerId: "worker-1" },
				shutdownSignal: new AbortController().signal,
			}),
		).toEqual({ type: "terminal", status: "done" });
		const [stored] = await tdb.db
			.select({
				status: runs.status,
				liveStreamFailedAt: runs.liveStreamFailedAt,
			})
			.from(runs)
			.where(eq(runs.runId, run.runId));
		expect(stored).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
	});

	it("fails closed on unreliable mirror evidence", async () => {
		const { acquired, run } = await startRun();
		const serving = createRunServing({
			db: tdb.db,
			processor: async () => ({
				disposition: "completed",
				streamMetadata: {
					mirrorErrorObserved: true,
					mirroredMainSessionId: "session-unreliable",
				},
			}),
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			logger: silentLogger,
		});

		expect(
			await serving.serveStartedRun({
				run,
				owner: { ...acquired, runId: run.runId, workerId: "worker-1" },
				shutdownSignal: new AbortController().signal,
			}),
		).toEqual({ type: "terminal", status: "error" });
	});

	it("publishes staged artifacts and resumable session evidence atomically", async () => {
		const { acquired, run } = await startRun();
		const owner = { ...acquired, runId: run.runId, workerId: "worker-1" };
		await createConversationRuntimeTx(tdb.db, acquired);
		await recordArtifactObjectsTx(tdb.db, {
			objects: [
				{
					objectKey: "objects/opaque-1",
					userId: run.userId,
					conversationId: run.conversationId,
					runId: run.runId,
					path: "report.txt",
				},
			],
		});
		const serving = createRunServing({
			db: tdb.db,
			processor: async () => ({
				disposition: "completed",
				streamMetadata: {
					mirrorErrorObserved: false,
					mirroredMainSessionId: "session-1",
				},
				artifactPublication: {
					artifacts: [
						{
							artifactId: "artifact-1",
							path: "report.txt",
							objectKey: "objects/opaque-1",
							sizeBytes: 12,
							contentType: "text/plain",
						},
					],
				},
			}),
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			logger: silentLogger,
		});

		expect(
			await serving.serveStartedRun({
				run,
				owner,
				shutdownSignal: new AbortController().signal,
			}),
		).toEqual({ type: "terminal", status: "done" });
		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([
			expect.objectContaining({
				artifactId: "artifact-1",
				objectKey: "objects/opaque-1",
				path: "report.txt",
			}),
		]);
		expect(await tdb.db.select().from(conversationRuntime)).toEqual([
			expect.objectContaining({ agentSessionId: "session-1" }),
		]);
	});
});
