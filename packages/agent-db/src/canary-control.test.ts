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
	admitCanaryScenarioTx,
	advanceCanaryCampaignTx,
	CanaryAdmissionError,
	computeCanaryCampaignInputChecksum,
	expireCanaryAuditRecordsTx,
	startCanaryCampaignTx,
} from "./canary-control";
import { markFargateLaneAwareDeploymentReady } from "./execution-lane-deployment";
import { ActiveRunConflictError, admitQueuedRunTx } from "./run-store";
import {
	canaryCampaigns,
	canaryDispatchOutbox,
	conversations,
	executionLaneDeployments,
	runEvents,
	runs,
} from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

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

const campaign = {
	campaignId: "campaign-449",
	idempotencyKey: "operator-key-449",
	campaignVersion: "2026-08-14.1",
	fixtureVersion: "fixture-v1",
	fixtureChecksum: "fixture-checksum",
	model: "configured-model",
	scenarioId: "baseline-v1",
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49044201",
	collectionId: "canary-collection",
	runId: "0198b5a2-1c70-7be1-8e52-acdeab98d101",
	messageId: "0198b5a2-2c70-7855-b090-acdeab98d102",
	dispatchId: "0198b5a2-3c70-79d1-8d0c-acdeab98d103",
	prompt:
		"Use the configured synthetic fixture and publish the nonce artifact.",
} as const;

async function seedConfiguredCampaign(
	conversation: {
		executionLane?: "fargate" | "agentcore_canary";
		archivedAt?: Date;
	} = {},
): Promise<void> {
	await tdb.db.insert(canaryCampaigns).values({
		campaignId: campaign.campaignId,
		idempotencyKey: campaign.idempotencyKey,
		campaignVersion: campaign.campaignVersion,
		fixtureVersion: campaign.fixtureVersion,
		fixtureChecksum: campaign.fixtureChecksum,
		inputChecksum: computeCanaryCampaignInputChecksum(campaign),
		model: campaign.model,
		scenarioId: campaign.scenarioId,
		userId: campaign.userId,
		conversationId: campaign.conversationId,
		runId: campaign.runId,
		messageId: campaign.messageId,
	});
	await tdb.db.insert(conversations).values({
		userId: campaign.userId,
		conversationId: campaign.conversationId,
		scope: "collection",
		collectionId: campaign.collectionId,
		executionLane: conversation.executionLane ?? "agentcore_canary",
		archivedAt: conversation.archivedAt,
	});
}

describe("startCanaryCampaignTx", () => {
	it("atomically creates the Campaign, synthetic scenario Run, and one pending dispatch audit", async () => {
		const result = await startCanaryCampaignTx(tdb.db, campaign);

		expect(result).toMatchObject({
			outcome: "created",
			campaign: {
				campaignId: campaign.campaignId,
				lifecycle: "preparing",
				verdict: null,
				conversationId: campaign.conversationId,
				runId: campaign.runId,
			},
		});
		expect(await tdb.db.select().from(conversations)).toMatchObject([
			{
				userId: campaign.userId,
				conversationId: campaign.conversationId,
				scope: "collection",
				collectionId: campaign.collectionId,
				executionLane: "agentcore_canary",
			},
		]);
		expect(await tdb.db.select().from(runs)).toMatchObject([
			{
				runId: campaign.runId,
				status: "queued",
				normalizedInput: {
					version: 1,
					messageId: campaign.messageId,
					text: campaign.prompt,
				},
			},
		]);
		expect(await tdb.db.select().from(runEvents)).toMatchObject([
			{
				runId: campaign.runId,
				seq: 1,
				type: "run_started",
			},
		]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toMatchObject([
			{
				dispatchId: campaign.dispatchId,
				campaignId: campaign.campaignId,
				scenarioId: campaign.scenarioId,
				userId: campaign.userId,
				conversationId: campaign.conversationId,
				runId: campaign.runId,
				executionLane: "agentcore_canary",
				publishedAt: null,
			},
		]);
	});

	it("refuses same-key reuse when deployment-owned prompt input changes", async () => {
		await startCanaryCampaignTx(tdb.db, campaign);

		await expect(
			startCanaryCampaignTx(tdb.db, {
				...campaign,
				prompt: "a changed deployed prompt",
			}),
		).rejects.toThrow("different Canary Campaign input");
		expect(await tdb.db.select().from(runs)).toHaveLength(1);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toHaveLength(1);
	});

	it("reattaches exact control and admission retries without duplicating durable work", async () => {
		const first = await startCanaryCampaignTx(tdb.db, campaign);
		const controlRetry = await startCanaryCampaignTx(tdb.db, campaign);
		const admissionRetry = await admitCanaryScenarioTx(tdb.db, campaign);

		expect(first.outcome).toBe("created");
		expect(controlRetry.outcome).toBe("existing");
		expect(admissionRetry.outcome).toBe("existing");
		expect(await tdb.db.select().from(canaryCampaigns)).toHaveLength(1);
		expect(await tdb.db.select().from(conversations)).toHaveLength(1);
		expect(await tdb.db.select().from(runs)).toHaveLength(1);
		expect(await tdb.db.select().from(runEvents)).toHaveLength(1);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toHaveLength(1);
	});

	it("refuses idempotency-key reuse with different trusted Campaign input", async () => {
		await startCanaryCampaignTx(tdb.db, campaign);

		await expect(
			startCanaryCampaignTx(tdb.db, {
				...campaign,
				model: "different-model",
			}),
		).rejects.toThrow("different Canary Campaign input");
		expect(await tdb.db.select().from(canaryCampaigns)).toHaveLength(1);
		expect(await tdb.db.select().from(runs)).toHaveLength(1);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toHaveLength(1);
	});

	it("refuses another key while one Campaign is active without creating partial state", async () => {
		await startCanaryCampaignTx(tdb.db, campaign);

		const refused = await startCanaryCampaignTx(tdb.db, {
			...campaign,
			campaignId: "campaign-other",
			idempotencyKey: "operator-key-other",
			conversationId: "conversation-other",
			runId: "run-other",
			messageId: "message-other",
			dispatchId: "dispatch-other",
		});

		expect(refused).toMatchObject({
			outcome: "active_campaign",
			campaign: { campaignId: campaign.campaignId },
		});
		expect(await tdb.db.select().from(canaryCampaigns)).toHaveLength(1);
		expect(await tdb.db.select().from(conversations)).toHaveLength(1);
		expect(await tdb.db.select().from(runs)).toHaveLength(1);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toHaveLength(1);
	});

	it("ordinary Fargate admission never creates an AgentCore dispatch", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "ordinary-conversation",
			scope: "general",
		});

		await admitQueuedRunTx(tdb.db, {
			runId: "ordinary-run",
			userId: "member-1",
			conversationId: "ordinary-conversation",
			messageId: "ordinary-message",
			text: "ordinary user work",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});

		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);
	});

	it("leaves no outbox or Run when creation is disabled or collides with durable state", async () => {
		await tdb.db.delete(executionLaneDeployments);
		await expect(startCanaryCampaignTx(tdb.db, campaign)).rejects.toThrow(
			"AgentCore-canary creation is disabled",
		);
		expect(await tdb.db.select().from(canaryCampaigns)).toEqual([]);
		expect(await tdb.db.select().from(conversations)).toEqual([]);
		expect(await tdb.db.select().from(runs)).toEqual([]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);

		await markFargateLaneAwareDeploymentReady(tdb.db);
		await tdb.db.insert(conversations).values({
			userId: campaign.userId,
			conversationId: campaign.conversationId,
			scope: "general",
		});
		await expect(startCanaryCampaignTx(tdb.db, campaign)).rejects.toThrow();
		expect(await tdb.db.select().from(canaryCampaigns)).toEqual([]);
		expect(await tdb.db.select().from(runs)).toEqual([]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);
	});

	it("rejects archived, cross-lane, and busy Conversation admission without an orphan dispatch", async () => {
		await seedConfiguredCampaign({ archivedAt: new Date() });
		await expect(
			admitCanaryScenarioTx(tdb.db, campaign),
		).rejects.toBeInstanceOf(CanaryAdmissionError);
		expect(await tdb.db.select().from(runs)).toEqual([]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);

		await tdb.db
			.update(conversations)
			.set({ archivedAt: null, executionLane: "fargate" })
			.where(eq(conversations.conversationId, campaign.conversationId));
		await expect(
			admitCanaryScenarioTx(tdb.db, campaign),
		).rejects.toBeInstanceOf(CanaryAdmissionError);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);

		await tdb.db
			.update(conversations)
			.set({ executionLane: "agentcore_canary" })
			.where(eq(conversations.conversationId, campaign.conversationId));
		await tdb.db.insert(runs).values({
			runId: "already-active",
			userId: campaign.userId,
			conversationId: campaign.conversationId,
			status: "queued",
		});
		await expect(
			admitCanaryScenarioTx(tdb.db, campaign),
		).rejects.toBeInstanceOf(ActiveRunConflictError);
		expect(
			(await tdb.db.select().from(runs)).map(({ runId }) => runId),
		).toEqual(["already-active"]);
		expect(await tdb.db.select().from(runEvents)).toEqual([]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);
	});

	it("rolls Run admission back if the atomic outbox insert fails", async () => {
		await seedConfiguredCampaign();
		await tdb.db.insert(canaryDispatchOutbox).values({
			dispatchId: campaign.dispatchId,
			campaignId: campaign.campaignId,
			scenarioId: "preexisting-audit",
			userId: campaign.userId,
			conversationId: campaign.conversationId,
			runId: "preexisting-audit-run",
			executionLane: "agentcore_canary",
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
		});

		await expect(admitCanaryScenarioTx(tdb.db, campaign)).rejects.toThrow();

		expect(await tdb.db.select().from(runs)).toEqual([]);
		expect(await tdb.db.select().from(runEvents)).toEqual([]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toHaveLength(1);
	});

	it("preserves bounded Campaign and dispatch audit after synthetic content deletion", async () => {
		await startCanaryCampaignTx(tdb.db, campaign);
		await tdb.db
			.update(runs)
			.set({ status: "done", terminalAt: new Date() })
			.where(eq(runs.runId, campaign.runId));

		await tdb.db
			.delete(conversations)
			.where(eq(conversations.conversationId, campaign.conversationId));

		expect(await tdb.db.select().from(conversations)).toEqual([]);
		expect(await tdb.db.select().from(runs)).toEqual([]);
		expect(await tdb.db.select().from(runEvents)).toEqual([]);
		expect(await tdb.db.select().from(canaryCampaigns)).toMatchObject([
			{
				campaignId: campaign.campaignId,
				conversationId: campaign.conversationId,
				runId: campaign.runId,
			},
		]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toMatchObject([
			{
				dispatchId: campaign.dispatchId,
				conversationId: campaign.conversationId,
				runId: campaign.runId,
			},
		]);
	});

	it("advances lifecycle monotonically, records verdict only at completion, and expires audit after 30 days", async () => {
		const started = await startCanaryCampaignTx(tdb.db, campaign);
		if (started.outcome !== "created") throw new Error("unreachable");
		const retentionMs = started.campaign.expiresAt.getTime() - Date.now();
		expect(retentionMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1_000);
		expect(retentionMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1_000);

		await expect(
			advanceCanaryCampaignTx(tdb.db, {
				campaignId: campaign.campaignId,
				expectedLifecycle: "preparing",
				lifecycle: "running",
			}),
		).resolves.toMatchObject({ outcome: "advanced", lifecycle: "running" });
		await expect(
			advanceCanaryCampaignTx(tdb.db, {
				campaignId: campaign.campaignId,
				expectedLifecycle: "running",
				lifecycle: "provisioning",
			}),
		).rejects.toThrow("monotonic");
		await expect(
			advanceCanaryCampaignTx(tdb.db, {
				campaignId: campaign.campaignId,
				expectedLifecycle: "running",
				lifecycle: "complete",
			}),
		).rejects.toThrow("verdict");
		await expect(
			advanceCanaryCampaignTx(tdb.db, {
				campaignId: campaign.campaignId,
				expectedLifecycle: "running",
				lifecycle: "complete",
				verdict: "inconclusive",
			}),
		).resolves.toMatchObject({
			outcome: "advanced",
			lifecycle: "complete",
			verdict: "inconclusive",
		});

		await tdb.db
			.update(canaryCampaigns)
			.set({ expiresAt: sql`now() - interval '1 second'` })
			.where(eq(canaryCampaigns.campaignId, campaign.campaignId));
		await tdb.db
			.update(canaryDispatchOutbox)
			.set({ expiresAt: sql`now() - interval '1 second'` })
			.where(eq(canaryDispatchOutbox.campaignId, campaign.campaignId));

		expect(await expireCanaryAuditRecordsTx(tdb.db)).toEqual({
			campaignsDeleted: 1,
			dispatchesDeleted: 1,
		});
		expect(await tdb.db.select().from(canaryCampaigns)).toEqual([]);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toEqual([]);
	});
});
