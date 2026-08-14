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
import { createDatabase, type Database } from "./client";
import { markFargateLaneAwareDeploymentReady } from "./execution-lane-deployment";
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
	},
);
