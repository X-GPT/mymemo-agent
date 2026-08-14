import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { eq, inArray, ne } from "drizzle-orm";
import { startCanaryCampaignTx } from "./canary-control";
import {
	acquireCanaryDispatchTx,
	type CanaryDispatchIdentity,
	claimCanaryDispatchesTx,
} from "./canary-dispatch";
import { createDatabase, type Database } from "./client";
import { claimConversationTx } from "./conversation-ownership";
import { markFargateLaneAwareDeploymentReady } from "./execution-lane-deployment";
import { requestRunInterruptionTx } from "./run-store";
import {
	canaryCampaigns,
	canaryDispatchOutbox,
	conversations,
	runs,
} from "./schema";

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = DB_URL !== "";
if (RUN) setDefaultTimeout(30_000);

const TEST_ID = `canary-control-${crypto.randomUUID()}`;
const CAMPAIGN_IDS = [`${TEST_ID}-a`, `${TEST_ID}-b`] as const;
let db: Database;

function input(index: 0 | 1) {
	const suffix = index === 0 ? "a" : "b";
	return {
		campaignId: CAMPAIGN_IDS[index],
		idempotencyKey: `${TEST_ID}-key-${suffix}`,
		campaignVersion: "postgres-concurrency-v1",
		fixtureVersion: "fixture-v1",
		fixtureChecksum: "fixture-checksum",
		model: "configured-model",
		scenarioId: "baseline-v1",
		userId: TEST_ID,
		conversationId: `${TEST_ID}-conversation-${suffix}`,
		collectionId: `${TEST_ID}-collection`,
		runId: `${TEST_ID}-run-${suffix}`,
		messageId: `${TEST_ID}-message-${suffix}`,
		dispatchId: `${TEST_ID}-dispatch-${suffix}`,
		prompt: "configured synthetic prompt",
	} as const;
}

async function deleteOwnRows(): Promise<void> {
	await db
		.delete(canaryDispatchOutbox)
		.where(inArray(canaryDispatchOutbox.campaignId, CAMPAIGN_IDS));
	await db.delete(conversations).where(eq(conversations.userId, TEST_ID));
	await db
		.delete(canaryCampaigns)
		.where(inArray(canaryCampaigns.campaignId, CAMPAIGN_IDS));
}

async function loadDispatch(
	exact: ReturnType<typeof input>,
): Promise<CanaryDispatchIdentity> {
	const [outbox] = await db
		.select()
		.from(canaryDispatchOutbox)
		.where(eq(canaryDispatchOutbox.dispatchId, exact.dispatchId));
	if (!outbox) throw new Error("Canary dispatch fixture was not admitted");
	return {
		schemaVersion: 1,
		dispatchId: outbox.dispatchId,
		campaignId: outbox.campaignId,
		scenarioId: outbox.scenarioId,
		userId: outbox.userId,
		conversationId: outbox.conversationId,
		runId: outbox.runId,
		runtimeSessionId: outbox.conversationId,
		expectedExecutionLane: "agentcore_canary",
		admittedAt: outbox.admittedAt,
	};
}

describe.skipIf(!RUN)(
	"Canary Campaign exclusivity against real Postgres",
	() => {
		beforeAll(async () => {
			db = createDatabase(DB_URL);
			await deleteOwnRows();
			const [foreignActive] = await db
				.select({ campaignId: canaryCampaigns.campaignId })
				.from(canaryCampaigns)
				.where(ne(canaryCampaigns.lifecycle, "complete"))
				.limit(1);
			if (foreignActive) {
				throw new Error(
					`AGENT_DATABASE_URL already holds active Canary Campaign ${foreignActive.campaignId}; use a scratch integration database`,
				);
			}
			await markFargateLaneAwareDeploymentReady(db);
		});

		beforeEach(deleteOwnRows);

		afterAll(async () => {
			await deleteOwnRows();
			await db.$client.end();
		});

		it("commits exactly one of two concurrently started keys", async () => {
			const outcomes = await Promise.all([
				startCanaryCampaignTx(db, input(0)),
				startCanaryCampaignTx(db, input(1)),
			]);

			expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual([
				"active_campaign",
				"created",
			]);
			expect(
				await db
					.select({ campaignId: canaryCampaigns.campaignId })
					.from(canaryCampaigns)
					.where(inArray(canaryCampaigns.campaignId, CAMPAIGN_IDS)),
			).toHaveLength(1);
			expect(
				await db
					.select()
					.from(canaryDispatchOutbox)
					.where(inArray(canaryDispatchOutbox.campaignId, CAMPAIGN_IDS)),
			).toHaveLength(1);
			expect(
				await db.select().from(runs).where(eq(runs.userId, TEST_ID)),
			).toHaveLength(1);
		});

		it("reattaches concurrent exact retries to one Campaign, Run, and dispatch", async () => {
			const exact = input(0);
			const outcomes = await Promise.all([
				startCanaryCampaignTx(db, exact),
				startCanaryCampaignTx(db, exact),
			]);

			expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual([
				"created",
				"existing",
			]);
			expect(
				await db
					.select()
					.from(canaryCampaigns)
					.where(eq(canaryCampaigns.campaignId, exact.campaignId)),
			).toHaveLength(1);
			expect(
				await db
					.select()
					.from(canaryDispatchOutbox)
					.where(eq(canaryDispatchOutbox.campaignId, exact.campaignId)),
			).toHaveLength(1);
			expect(
				await db.select().from(runs).where(eq(runs.runId, exact.runId)),
			).toHaveLength(1);
		});

		it("lets only one concurrent publisher lease an exact dispatch", async () => {
			await startCanaryCampaignTx(db, input(0));
			const now = new Date();
			const claims = await Promise.all([
				claimCanaryDispatchesTx(db, { publisherId: "publisher-a", now }),
				claimCanaryDispatchesTx(db, { publisherId: "publisher-b", now }),
			]);

			expect(claims.map((claim) => claim.length).sort()).toEqual([0, 1]);
			expect(claims.flat()[0]?.runId).toBe(input(0).runId);
		});

		it("keeps generic Fargate Claim disjoint from exact AgentCore acquisition", async () => {
			const exact = input(0);
			await startCanaryCampaignTx(db, exact);
			const dispatch = await loadDispatch(exact);

			const [generic, acquired] = await Promise.all([
				claimConversationTx(db, { workerId: "fargate-racer" }),
				acquireCanaryDispatchTx(db, {
					dispatch,
					workerId: "agentcore-racer",
				}),
			]);

			expect(generic).toBeNull();
			expect(acquired.disposition).toBe("acquired");
		});

		it("serializes duplicate Runtime invocations to acquired then already_acquired", async () => {
			const exact = input(0);
			await startCanaryCampaignTx(db, exact);
			const dispatch = await loadDispatch(exact);

			const results = await Promise.all([
				acquireCanaryDispatchTx(db, {
					dispatch,
					workerId: "agentcore-invocation-a",
				}),
				acquireCanaryDispatchTx(db, {
					dispatch,
					workerId: "agentcore-invocation-b",
				}),
			]);

			expect(results.map(({ disposition }) => disposition).sort()).toEqual([
				"acquired",
				"already_acquired",
			]);
		});

		it("never reacquires expired running Ownership before Reclamation", async () => {
			const exact = input(0);
			await startCanaryCampaignTx(db, exact);
			const dispatch = await loadDispatch(exact);
			const acquiredAt = new Date();
			await acquireCanaryDispatchTx(db, {
				dispatch,
				workerId: "agentcore-dead-invocation",
				now: acquiredAt,
			});

			await expect(
				acquireCanaryDispatchTx(db, {
					dispatch,
					workerId: "agentcore-retry-invocation",
					now: new Date(acquiredAt.getTime() + 60_001),
				}),
			).resolves.toEqual({ disposition: "temporarily_unavailable" });
		});

		it("serializes queued interruption against exact acquisition without a second execution", async () => {
			const exact = input(0);
			await startCanaryCampaignTx(db, exact);
			const dispatch = await loadDispatch(exact);

			const [acquisition, interruption] = await Promise.all([
				acquireCanaryDispatchTx(db, {
					dispatch,
					workerId: "agentcore-terminal-racer",
				}),
				requestRunInterruptionTx(db, {
					runId: exact.runId,
					userId: exact.userId,
					conversationId: exact.conversationId,
				}),
			]);

			expect(["acquired", "terminal"]).toContain(acquisition.disposition);
			expect(["interrupted", "interrupt_requested"]).toContain(
				interruption.outcome,
			);
			expect(
				await db
					.select({ status: runs.status })
					.from(runs)
					.where(eq(runs.runId, exact.runId)),
			).toMatchObject([
				{
					status: expect.stringMatching(/^(interrupted|interrupt_requested)$/),
				},
			]);
		});

		it("rejects a lane-mismatched dispatch while Fargate can Claim the queued Run", async () => {
			const exact = input(0);
			await startCanaryCampaignTx(db, exact);
			const dispatch = await loadDispatch(exact);
			await db
				.update(conversations)
				.set({ executionLane: "fargate" })
				.where(eq(conversations.conversationId, exact.conversationId));

			await expect(
				acquireCanaryDispatchTx(db, {
					dispatch,
					workerId: "agentcore-wrong-lane",
				}),
			).resolves.toEqual({ disposition: "invalid_dispatch" });
			await expect(
				claimConversationTx(db, { workerId: "fargate-correct-lane" }),
			).resolves.toMatchObject({ conversationId: exact.conversationId });
		});
	},
);
