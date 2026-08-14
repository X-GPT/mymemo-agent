import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { markFargateLaneAwareDeploymentReady } from "@mymemo/agent-db/execution-lane-deployment";
import {
	canaryCampaigns,
	canaryDispatchOutbox,
	conversations,
	executionLaneDeployments,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import {
	createCanaryControl,
	deriveCanaryScenarioIdentities,
	parseCanaryStartRequest,
} from "./control";
import type { CanaryFixtureConfig, CanaryFixtureVerifier } from "./fixture";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(canaryDispatchOutbox);
	await tdb.db.delete(canaryCampaigns);
	await tdb.db.delete(conversations);
	await tdb.db.delete(executionLaneDeployments);
	await markFargateLaneAwareDeploymentReady(tdb.db);
});

const fixture: CanaryFixtureConfig = {
	version: "fixture-v1",
	checksum: "c2c994e77fdca1bce1800f9055292d87a282937ff17240de1f0cc3c6bd7ab014",
	identity: { kind: "non_human", userId: "agentcore-canary-service" },
	collectionId: "agentcore-canary-fixture",
	documents: [
		{
			documentId: "fixture-doc-v3",
			version: 3,
			contentSha256:
				"cab47e977f6a92635793dc70f27931ccea0f22bcc5e482b02571ade91a6b9a07",
		},
	],
};

const config = {
	campaignVersion: "2026-08-14.1",
	fixture,
	scenario: {
		id: "baseline-v1",
		prompt: "Use the configured fixture and publish the configured nonce.",
		model: "configured-model",
	},
} as const;

class RecordingVerifier implements CanaryFixtureVerifier {
	verified: CanaryFixtureConfig[] = [];

	async verify(configured: CanaryFixtureConfig): Promise<void> {
		this.verified.push(configured);
	}
}

describe("the operator Canary control boundary", () => {
	it("keeps scenario identities stable across control-task retries", () => {
		expect(
			deriveCanaryScenarioIdentities({
				idempotencyKey: "operator-approved-449",
				campaignVersion: "2026-08-14.1",
				scenarioId: "baseline-v1",
			}),
		).toEqual({
			campaignId: "fd82be97-54bd-5a2f-b2e6-1d248fee4f39",
			conversationId: "967f9ca4-dc26-5689-b265-0944dd96f402",
			runId: "f5b700ae-a24c-5ef1-9167-950425abcbe5",
			messageId: "48126c27-b977-5299-805c-9baa4502d82b",
			dispatchId: "26bfb276-edcd-50e0-8a48-1778c890220c",
		});
	});

	it("accepts only an idempotency key and deployed Campaign version", () => {
		expect(
			parseCanaryStartRequest({
				idempotencyKey: "operator-approved-449",
				campaignVersion: config.campaignVersion,
			}),
		).toEqual({
			idempotencyKey: "operator-approved-449",
			campaignVersion: config.campaignVersion,
		});

		for (const forbidden of [
			"identity",
			"scope",
			"prompt",
			"model",
			"collectionId",
			"conversationId",
			"runId",
			"executionLane",
		]) {
			expect(() =>
				parseCanaryStartRequest({
					idempotencyKey: "operator-approved-449",
					campaignVersion: config.campaignVersion,
					[forbidden]: "operator-value",
				}),
			).toThrow("exactly idempotencyKey and campaignVersion");
		}
	});

	it("verifies the configured fixture then admits deterministic configuration-owned identities", async () => {
		const verifier = new RecordingVerifier();
		const control = createCanaryControl({ db: tdb.db, config, verifier });

		const created = await control.start({
			idempotencyKey: "operator-approved-449",
			campaignVersion: config.campaignVersion,
		});
		const expected = deriveCanaryScenarioIdentities({
			idempotencyKey: "operator-approved-449",
			campaignVersion: config.campaignVersion,
			scenarioId: config.scenario.id,
		});

		expect(created).toMatchObject({ outcome: "created", identities: expected });
		expect(verifier.verified).toEqual([fixture]);
		expect(await tdb.db.select().from(conversations)).toMatchObject([
			{
				userId: fixture.identity.userId,
				conversationId: expected.conversationId,
				collectionId: fixture.collectionId,
				executionLane: "agentcore_canary",
			},
		]);
		expect(await tdb.db.select().from(runs)).toMatchObject([
			{
				runId: expected.runId,
				normalizedInput: {
					messageId: expected.messageId,
					text: config.scenario.prompt,
				},
			},
		]);
		expect(await tdb.db.select().from(runEvents)).toHaveLength(1);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toMatchObject([
			{
				dispatchId: expected.dispatchId,
				runId: expected.runId,
			},
		]);
	});

	it("reattaches an exact retry without re-verifying or creating another scenario", async () => {
		const verifier = new RecordingVerifier();
		const control = createCanaryControl({ db: tdb.db, config, verifier });
		const request = {
			idempotencyKey: "operator-approved-449",
			campaignVersion: config.campaignVersion,
		};

		await control.start(request);
		verifier.verify = async () => {
			throw new Error("fixture changed after durable admission");
		};
		const retry = await control.start(request);

		expect(retry.outcome).toBe("existing");
		expect(await tdb.db.select().from(canaryCampaigns)).toHaveLength(1);
		expect(await tdb.db.select().from(runs)).toHaveLength(1);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toHaveLength(1);
	});

	it("refuses a different key from durable exclusivity before fixture work", async () => {
		const verifier = new RecordingVerifier();
		const control = createCanaryControl({ db: tdb.db, config, verifier });
		await control.start({
			idempotencyKey: "operator-approved-449",
			campaignVersion: config.campaignVersion,
		});
		verifier.verify = async () => {
			throw new Error("fixture verification must not run for refused work");
		};

		await expect(
			control.start({
				idempotencyKey: "different-approved-key",
				campaignVersion: config.campaignVersion,
			}),
		).resolves.toMatchObject({
			outcome: "active_campaign",
			campaign: { idempotencyKey: "operator-approved-449" },
		});
		expect(await tdb.db.select().from(canaryCampaigns)).toHaveLength(1);
		expect(await tdb.db.select().from(runs)).toHaveLength(1);
	});

	it("fails before durable creation when fixture verification refuses drift", async () => {
		const verifier: CanaryFixtureVerifier = {
			verify: async () => {
				throw new Error("Canary fixture checksum mismatch");
			},
		};
		const control = createCanaryControl({ db: tdb.db, config, verifier });

		await expect(
			control.start({
				idempotencyKey: "operator-approved-449",
				campaignVersion: config.campaignVersion,
			}),
		).rejects.toThrow("fixture checksum mismatch");
		expect(await tdb.db.select().from(canaryCampaigns)).toEqual([]);
		expect(await tdb.db.select().from(conversations)).toEqual([]);
		expect(await tdb.db.select().from(runs)).toEqual([]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);
	});
});
