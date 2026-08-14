import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { claimConversationTx } from "@mymemo/agent-db/conversation-ownership";
import { startClaimedRunTx } from "@mymemo/agent-db/run-store";
import { conversations, runs } from "@mymemo/agent-db/schema";
import {
	createTestDatabase,
	seedQueuedRun,
	type TestDb,
} from "@mymemo/agent-db/testing";
import {
	createInMemoryLiveStreamRelay,
	createRedisLiveStreamRelay,
} from "@mymemo/live-text";
import { startRedisTestServer } from "@mymemo/test-support/redis-test-server";
import { createRunServing, type RunServing } from "agent-worker/run-serving";
import { eq, sql } from "drizzle-orm";
import { createCanaryExecutionServices } from "./execution-services";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

const silentLogger = { info() {}, warn() {}, error() {} };

async function startOwnedRun(input: {
	conversationId: string;
	runId: string;
	workerId: string;
}) {
	await tdb.db.insert(conversations).values({
		userId: "canary-service-user",
		conversationId: input.conversationId,
		scope: "general",
	});
	await seedQueuedRun(tdb.db, {
		runId: input.runId,
		userId: "canary-service-user",
		conversationId: input.conversationId,
	});
	const owner = await claimConversationTx(tdb.db, {
		workerId: input.workerId,
	});
	if (!owner || owner.conversationId !== input.conversationId) {
		throw new Error("test did not Claim the expected Conversation");
	}
	const started = await startClaimedRunTx(tdb.db, {
		owner,
		runId: input.runId,
		workerId: input.workerId,
	});
	if (started.outcome !== "started") throw new Error("test Run did not start");
	return owner;
}

function dispatchFor(input: {
	conversationId: string;
	runId: string;
	dispatchId: string;
}) {
	return {
		schemaVersion: 1 as const,
		dispatchId: input.dispatchId,
		campaignId: "campaign-451",
		scenarioId: "baseline-v1",
		userId: "canary-service-user",
		conversationId: input.conversationId,
		runId: input.runId,
		runtimeSessionId: input.conversationId,
		expectedExecutionLane: "agentcore_canary" as const,
		admittedAt: new Date("2026-08-14T20:00:00.000Z"),
	};
}

describe("AgentCore one-shot execution services", () => {
	it("serves the exact acquired Run once and releases its live Ownership", async () => {
		await tdb.db.insert(conversations).values({
			userId: "canary-service-user",
			conversationId: "conv-runtime-451",
			scope: "general",
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-runtime-451",
			userId: "canary-service-user",
			conversationId: "conv-runtime-451",
		});
		const owner = await claimConversationTx(tdb.db, {
			workerId: "boot-451/invocation-1",
		});
		if (!owner) throw new Error("test did not Claim the Conversation");
		const started = await startClaimedRunTx(tdb.db, {
			owner,
			runId: "run-runtime-451",
			workerId: "boot-451/invocation-1",
		});
		if (started.outcome !== "started")
			throw new Error("test Run did not start");

		let serveCount = 0;
		const runServing: RunServing = {
			heartbeat: async () => {},
			serveStartedRun: async (input) => {
				serveCount++;
				expect(input.run.runId).toBe("run-runtime-451");
				expect(input.owner).toEqual({
					userId: owner.userId,
					conversationId: owner.conversationId,
					epoch: owner.epoch,
					runId: "run-runtime-451",
					workerId: "boot-451/invocation-1",
				});
				return { type: "terminal", status: "done" };
			},
		};
		const services = createCanaryExecutionServices({
			db: tdb.db,
			acquire: async () => {
				throw new Error("not used in this test");
			},
			runServing,
			logger: { info() {}, warn() {}, error() {} },
		});
		const acquisition = {
			disposition: "acquired",
			owner: {
				userId: owner.userId,
				conversationId: owner.conversationId,
				epoch: owner.epoch,
			},
			workerId: "boot-451/invocation-1",
		} as const;

		await expect(
			services.serve({
				dispatch: {
					schemaVersion: 1,
					dispatchId: "dispatch-runtime-451",
					campaignId: "campaign-451",
					scenarioId: "baseline-v1",
					userId: owner.userId,
					conversationId: owner.conversationId,
					runId: "run-runtime-451",
					runtimeSessionId: owner.conversationId,
					expectedExecutionLane: "agentcore_canary",
					admittedAt: new Date("2026-08-14T20:00:00.000Z"),
				},
				acquisition,
				shutdownSignal: new AbortController().signal,
				onDetached() {},
			}),
		).resolves.toEqual({ type: "terminal", status: "done" });
		await services.release({
			owner: acquisition.owner,
			workerId: acquisition.workerId,
			runId: "run-runtime-451",
		});

		expect(serveCount).toBe(1);
		const [stored] = await tdb.db
			.select({ ownerWorkerId: conversations.ownerWorkerId })
			.from(conversations)
			.where(eq(conversations.conversationId, owner.conversationId));
		expect(stored?.ownerWorkerId).toBeNull();
	});

	it("runs a clientless Redis Live Stream through the one-shot serving seam", async () => {
		const conversationId = "conv-runtime-live-451";
		const runId = "run-runtime-live-451";
		const workerId = "boot-451/invocation-live";
		const owner = await startOwnedRun({ conversationId, runId, workerId });
		const redis = await startRedisTestServer();
		const relay = createRedisLiveStreamRelay({
			url: redis.url,
			deployment: "agentcore-runtime-test",
		});

		try {
			const services = createCanaryExecutionServices({
				db: tdb.db,
				acquire: async () => {
					throw new Error("not used in this test");
				},
				runServing: createRunServing({
					db: tdb.db,
					processor: async (context) => {
						await context.appendModelContent({
							kind: "assistant_message",
							payload: { messageId: "message-live", text: "clientless" },
						});
					},
					liveStreamRelay: relay,
					logger: silentLogger,
				}),
				logger: silentLogger,
			});
			expect(
				await services.serve({
					dispatch: dispatchFor({
						conversationId,
						runId,
						dispatchId: "dispatch-runtime-live-451",
					}),
					acquisition: { disposition: "acquired", owner, workerId },
					shutdownSignal: new AbortController().signal,
					onDetached() {},
				}),
			).toEqual({ type: "terminal", status: "done" });
			expect(await relay.attach(runId, new AbortController().signal)).toEqual({
				outcome: "no_producer",
			});
			const [stored] = await tdb.db
				.select({ status: runs.status })
				.from(runs)
				.where(eq(runs.runId, runId));
			expect(stored?.status).toBe("done");
		} finally {
			await relay.close();
			await redis.stop();
		}
	});

	it("keeps one-shot execution durable when its clientless relay fails", async () => {
		const conversationId = "conv-runtime-relay-failure-451";
		const runId = "run-runtime-relay-failure-451";
		const workerId = "boot-451/invocation-relay-failure";
		const owner = await startOwnedRun({ conversationId, runId, workerId });
		const relay = createInMemoryLiveStreamRelay();
		await relay.close();
		const services = createCanaryExecutionServices({
			db: tdb.db,
			acquire: async () => {
				throw new Error("not used in this test");
			},
			runServing: createRunServing({
				db: tdb.db,
				processor: async (context) => {
					await context.appendModelContent({
						kind: "assistant_message",
						payload: { messageId: "message-durable", text: "durable" },
					});
				},
				liveStreamRelay: relay,
				logger: silentLogger,
			}),
			logger: silentLogger,
		});

		expect(
			await services.serve({
				dispatch: dispatchFor({
					conversationId,
					runId,
					dispatchId: "dispatch-runtime-relay-failure-451",
				}),
				acquisition: { disposition: "acquired", owner, workerId },
				shutdownSignal: new AbortController().signal,
				onDetached() {},
			}),
		).toEqual({ type: "terminal", status: "done" });
		const [stored] = await tdb.db
			.select({
				status: runs.status,
				liveStreamFailedAt: runs.liveStreamFailedAt,
			})
			.from(runs)
			.where(eq(runs.runId, runId));
		expect(stored).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});
	});

	it("renews the same Conversation fence after shared serving detaches", async () => {
		const [conversation] = await tdb.db.select().from(conversations).limit(1);
		if (!conversation) throw new Error("test Conversation is missing");
		await tdb.db
			.update(conversations)
			.set({
				ownerWorkerId: "boot-451/invocation-2",
				ownerUntil: sql`now() + interval '1 second'`,
				epoch: sql`${conversations.epoch} + 1`,
			})
			.where(eq(conversations.conversationId, conversation.conversationId));
		const [owned] = await tdb.db
			.select()
			.from(conversations)
			.where(eq(conversations.conversationId, conversation.conversationId));
		if (!owned) throw new Error("test Ownership is missing");
		const services = createCanaryExecutionServices({
			db: tdb.db,
			acquire: async () => {
				throw new Error("not used in this test");
			},
			runServing: {
				heartbeat: async () => {},
				serveStartedRun: async () => ({ type: "terminal", status: null }),
			},
			logger: { info() {}, warn() {}, error() {} },
		});

		expect(
			await services.heartbeat({
				owner: {
					userId: owned.userId,
					conversationId: owned.conversationId,
					epoch: owned.epoch,
				},
				workerId: "boot-451/invocation-2",
				runId: "run-runtime-451",
				detached: true,
			}),
		).toBe("alive");
		const [renewed] = await tdb.db
			.select({ ownerUntil: conversations.ownerUntil })
			.from(conversations)
			.where(eq(conversations.conversationId, owned.conversationId));
		expect(renewed?.ownerUntil?.getTime()).toBeGreaterThan(Date.now() + 30_000);
		await tdb.db.delete(runs);
		await tdb.db.delete(conversations);
	});
});
