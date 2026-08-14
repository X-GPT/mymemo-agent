import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { eq } from "drizzle-orm";
import {
	computeCanaryCampaignInputChecksum,
	type StartCanaryCampaignInput,
} from "./canary-control";
import {
	acquireCanaryDispatchTx,
	claimCanaryDispatchesTx,
	confirmCanaryDispatchPublishedTx,
	markOverdueCanaryDispatchesTx,
	requestCanaryDispatchReplayTx,
} from "./canary-dispatch";
import { markFargateLaneAwareDeploymentReady } from "./execution-lane-deployment";
import {
	canaryCampaigns,
	canaryDispatchOutbox,
	conversations,
	executionLaneDeployments,
	runs,
} from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

const campaign = {
	campaignId: "campaign-450",
	idempotencyKey: "operator-key-450",
	campaignVersion: "2026-08-14.1",
	fixtureVersion: "fixture-v1",
	fixtureChecksum: "fixture-checksum",
	model: "configured-model",
	scenarioId: "baseline-v1",
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	collectionId: "canary-collection",
	runId: "0198b5a2-1c70-7be1-8e52-acdeab984501",
	messageId: "0198b5a2-2c70-7855-b090-acdeab984502",
	dispatchId: "0198b5a2-3c70-79d1-8d0c-acdeab984503",
	prompt: "Use the configured synthetic fixture.",
} satisfies StartCanaryCampaignInput;

const admittedAt = new Date("2026-08-14T16:00:00.000Z");

const dispatch = {
	schemaVersion: 1 as const,
	dispatchId: campaign.dispatchId,
	campaignId: campaign.campaignId,
	scenarioId: campaign.scenarioId,
	userId: campaign.userId,
	conversationId: campaign.conversationId,
	runId: campaign.runId,
	runtimeSessionId: campaign.conversationId,
	expectedExecutionLane: "agentcore_canary" as const,
	admittedAt,
};

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
		executionLane: "agentcore_canary",
	});
	await tdb.db.insert(runs).values({
		runId: campaign.runId,
		userId: campaign.userId,
		conversationId: campaign.conversationId,
		status: "queued",
	});
	await tdb.db.insert(canaryDispatchOutbox).values({
		dispatchId: campaign.dispatchId,
		campaignId: campaign.campaignId,
		scenarioId: campaign.scenarioId,
		userId: campaign.userId,
		conversationId: campaign.conversationId,
		runId: campaign.runId,
		executionLane: "agentcore_canary",
		admittedAt,
		expiresAt: new Date("2026-09-14T00:00:00.000Z"),
	});
});

describe("acquireCanaryDispatchTx", () => {
	it("atomically establishes Conversation Ownership and starts the exact queued Run", async () => {
		const result = await acquireCanaryDispatchTx(tdb.db, {
			dispatch,
			workerId: "agentcore-boot/invocation-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		expect(result).toEqual({
			disposition: "acquired",
			owner: {
				userId: campaign.userId,
				conversationId: campaign.conversationId,
				epoch: 1,
			},
			workerId: "agentcore-boot/invocation-1",
		});
		expect(
			await tdb.db
				.select({
					epoch: conversations.epoch,
					ownerWorkerId: conversations.ownerWorkerId,
					ownerUntil: conversations.ownerUntil,
				})
				.from(conversations)
				.where(eq(conversations.conversationId, campaign.conversationId)),
		).toEqual([
			{
				epoch: 1,
				ownerWorkerId: "agentcore-boot/invocation-1",
				ownerUntil: new Date("2026-08-14T16:02:00.000Z"),
			},
		]);
		expect(
			await tdb.db
				.select({
					status: runs.status,
					executedByWorkerId: runs.executedByWorkerId,
				})
				.from(runs)
				.where(eq(runs.runId, campaign.runId)),
		).toEqual([
			{
				status: "running",
				executedByWorkerId: "agentcore-boot/invocation-1",
			},
		]);
	});

	it("reports a live duplicate as already acquired without changing its Ownership", async () => {
		const first = await acquireCanaryDispatchTx(tdb.db, {
			dispatch,
			workerId: "agentcore-boot/invocation-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});
		const duplicate = await acquireCanaryDispatchTx(tdb.db, {
			dispatch,
			workerId: "agentcore-boot/invocation-2",
			now: new Date("2026-08-14T16:01:30.000Z"),
		});

		expect(first.disposition).toBe("acquired");
		expect(duplicate).toEqual({
			disposition: "already_acquired",
			owner: {
				userId: campaign.userId,
				conversationId: campaign.conversationId,
				epoch: 1,
			},
			workerId: "agentcore-boot/invocation-1",
		});
		expect(
			await tdb.db
				.select({
					epoch: conversations.epoch,
					ownerWorkerId: conversations.ownerWorkerId,
				})
				.from(conversations),
		).toEqual([
			{
				epoch: 1,
				ownerWorkerId: "agentcore-boot/invocation-1",
			},
		]);
	});

	it("keeps an expired running Ownership retryable until Reclamation establishes an Outcome", async () => {
		await acquireCanaryDispatchTx(tdb.db, {
			dispatch,
			workerId: "agentcore-boot/dead-invocation",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		const retry = await acquireCanaryDispatchTx(tdb.db, {
			dispatch,
			workerId: "agentcore-boot/retry-invocation",
			now: new Date("2026-08-14T16:02:01.000Z"),
		});

		expect(retry).toEqual({ disposition: "temporarily_unavailable" });
		expect(
			await tdb.db
				.select({
					status: runs.status,
					executedByWorkerId: runs.executedByWorkerId,
				})
				.from(runs),
		).toEqual([
			{
				status: "running",
				executedByWorkerId: "agentcore-boot/dead-invocation",
			},
		]);
	});

	it("reports an exact Run that already has an Outcome as terminal", async () => {
		await tdb.db
			.update(runs)
			.set({ status: "interrupted", terminalAt: admittedAt })
			.where(eq(runs.runId, campaign.runId));

		await expect(
			acquireCanaryDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-boot/late-invocation",
				now: new Date("2026-08-14T16:01:00.000Z"),
			}),
		).resolves.toEqual({
			disposition: "terminal",
			status: "interrupted",
		});
	});

	it("acknowledges an exact terminal Run even after its Campaign completes", async () => {
		await tdb.db
			.update(runs)
			.set({ status: "done", terminalAt: admittedAt })
			.where(eq(runs.runId, campaign.runId));
		await tdb.db
			.update(canaryCampaigns)
			.set({ lifecycle: "complete", verdict: "inconclusive" })
			.where(eq(canaryCampaigns.campaignId, campaign.campaignId));

		await expect(
			acquireCanaryDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-boot/late-invocation",
			}),
		).resolves.toEqual({ disposition: "terminal", status: "done" });
	});

	it("classifies a queued Run from a cleaning Campaign as permanently invalid", async () => {
		await tdb.db
			.update(canaryCampaigns)
			.set({ lifecycle: "cleaning", provisionalVerdict: "inconclusive" })
			.where(eq(canaryCampaigns.campaignId, campaign.campaignId));

		await expect(
			acquireCanaryDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-boot/late-invocation",
			}),
		).resolves.toEqual({ disposition: "invalid_dispatch" });
	});

	it("classifies identity, session, and lane mismatches as invalid without acquiring", async () => {
		for (const mismatched of [
			{ ...dispatch, userId: "another-user" },
			{ ...dispatch, runtimeSessionId: "another-runtime-session" },
			{ ...dispatch, campaignId: "another-campaign" },
		]) {
			await expect(
				acquireCanaryDispatchTx(tdb.db, {
					dispatch: mismatched,
					workerId: "agentcore-invalid-invocation",
				}),
			).resolves.toEqual({ disposition: "invalid_dispatch" });
		}
		await tdb.db
			.update(conversations)
			.set({ executionLane: "fargate" })
			.where(eq(conversations.conversationId, campaign.conversationId));
		await expect(
			acquireCanaryDispatchTx(tdb.db, {
				dispatch,
				workerId: "agentcore-invalid-invocation",
			}),
		).resolves.toEqual({ disposition: "invalid_dispatch" });

		expect(
			await tdb.db
				.select({
					status: runs.status,
					ownerWorkerId: conversations.ownerWorkerId,
				})
				.from(runs)
				.innerJoin(
					conversations,
					eq(conversations.conversationId, runs.conversationId),
				),
		).toEqual([{ status: "queued", ownerWorkerId: null }]);
	});
});

describe("claimCanaryDispatchesTx", () => {
	it("can restrict a manual publisher claim to one exact dispatch", async () => {
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "manual-replay-publisher",
				dispatchId: "another-dispatch",
				now: new Date("2026-08-14T16:01:00.000Z"),
			}),
		).resolves.toEqual([]);
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "manual-replay-publisher",
				dispatchId: campaign.dispatchId,
				now: new Date("2026-08-14T16:01:00.000Z"),
			}),
		).resolves.toEqual([dispatch]);
	});

	it("leases an eligible pending dispatch for three minutes and returns its content-free identity", async () => {
		const claimed = await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		expect(claimed).toEqual([dispatch]);
		expect(
			await tdb.db
				.select({
					publishClaimedBy: canaryDispatchOutbox.publishClaimedBy,
					publishClaimUntil: canaryDispatchOutbox.publishClaimUntil,
					publishAttempts: canaryDispatchOutbox.publishAttempts,
				})
				.from(canaryDispatchOutbox),
		).toEqual([
			{
				publishClaimedBy: "publisher-1",
				publishClaimUntil: new Date("2026-08-14T16:04:00.000Z"),
				publishAttempts: 1,
			},
		]);
	});

	it("replays an ambiguous send only after its publish lease expires", async () => {
		await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-crashed",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "publisher-repair-early",
				now: new Date("2026-08-14T16:03:59.999Z"),
			}),
		).resolves.toEqual([]);
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "publisher-repair-after-expiry",
				now: new Date("2026-08-14T16:04:00.000Z"),
			}),
		).resolves.toEqual([dispatch]);
	});

	it("caps one publisher claim at ten rows", async () => {
		await tdb.db.insert(canaryDispatchOutbox).values(
			Array.from({ length: 10 }, (_, index) => ({
				dispatchId: `dispatch-extra-${index}`,
				campaignId: campaign.campaignId,
				scenarioId: `scenario-extra-${index}`,
				userId: campaign.userId,
				conversationId: campaign.conversationId,
				runId: `run-extra-${index}`,
				executionLane: "agentcore_canary" as const,
				admittedAt: new Date(admittedAt.getTime() + index + 1),
				expiresAt: new Date("2026-09-14T00:00:00.000Z"),
			})),
		);

		const first = await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-bounded",
			now: new Date("2026-08-14T16:01:00.000Z"),
			limit: 50,
		});
		const second = await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-remainder",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		expect(first).toHaveLength(10);
		expect(second).toHaveLength(1);
	});

	it("marks only the current publisher's confirmed send as published", async () => {
		await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		await expect(
			confirmCanaryDispatchPublishedTx(tdb.db, {
				dispatchId: campaign.dispatchId,
				publisherId: "publisher-1",
				now: new Date("2026-08-14T16:01:10.000Z"),
			}),
		).resolves.toBe(true);
		expect(
			await tdb.db
				.select({
					publishedAt: canaryDispatchOutbox.publishedAt,
					publishClaimedBy: canaryDispatchOutbox.publishClaimedBy,
					publishClaimUntil: canaryDispatchOutbox.publishClaimUntil,
				})
				.from(canaryDispatchOutbox),
		).toEqual([
			{
				publishedAt: new Date("2026-08-14T16:01:10.000Z"),
				publishClaimedBy: null,
				publishClaimUntil: null,
			},
		]);
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "publisher-2",
				now: new Date("2026-08-14T16:01:20.000Z"),
			}),
		).resolves.toEqual([]);
	});

	it("refuses confirmation after the publisher's lease expires", async () => {
		await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		await expect(
			confirmCanaryDispatchPublishedTx(tdb.db, {
				dispatchId: campaign.dispatchId,
				publisherId: "publisher-1",
				now: new Date("2026-08-14T16:04:00.000Z"),
			}),
		).resolves.toBe(false);
		expect(
			await tdb.db
				.select({ publishedAt: canaryDispatchOutbox.publishedAt })
				.from(canaryDispatchOutbox),
		).toEqual([{ publishedAt: null }]);
	});

	it("audits a manual replay and republishes the same Run identity", async () => {
		await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});
		await confirmCanaryDispatchPublishedTx(tdb.db, {
			dispatchId: campaign.dispatchId,
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:10.000Z"),
		});

		await expect(
			requestCanaryDispatchReplayTx(tdb.db, {
				dispatchId: campaign.dispatchId,
				requestedBy: "operator@example.com",
				now: new Date("2026-08-14T16:02:00.000Z"),
			}),
		).resolves.toBe(true);
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "manual-replay-publisher",
				now: new Date("2026-08-14T16:02:01.000Z"),
			}),
		).resolves.toEqual([dispatch]);
		expect(
			await tdb.db
				.select({
					replayRequestedBy: canaryDispatchOutbox.replayRequestedBy,
					replayRequestedAt: canaryDispatchOutbox.replayRequestedAt,
					publishAttempts: canaryDispatchOutbox.publishAttempts,
				})
				.from(canaryDispatchOutbox),
		).toEqual([
			{
				replayRequestedBy: "operator@example.com",
				replayRequestedAt: new Date("2026-08-14T16:02:00.000Z"),
				publishAttempts: 2,
			},
		]);
	});

	it("preserves a live publisher lease when auditing a manual replay", async () => {
		await claimCanaryDispatchesTx(tdb.db, {
			publisherId: "publisher-1",
			now: new Date("2026-08-14T16:01:00.000Z"),
		});

		await expect(
			requestCanaryDispatchReplayTx(tdb.db, {
				dispatchId: campaign.dispatchId,
				requestedBy: "operator@example.com",
				now: new Date("2026-08-14T16:02:00.000Z"),
			}),
		).resolves.toBe(true);
		expect(
			await tdb.db
				.select({
					publishClaimedBy: canaryDispatchOutbox.publishClaimedBy,
					publishClaimUntil: canaryDispatchOutbox.publishClaimUntil,
					replayRequestedBy: canaryDispatchOutbox.replayRequestedBy,
				})
				.from(canaryDispatchOutbox),
		).toEqual([
			{
				publishClaimedBy: "publisher-1",
				publishClaimUntil: new Date("2026-08-14T16:04:00.000Z"),
				replayRequestedBy: "operator@example.com",
			},
		]);
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "manual-replay-publisher",
				now: new Date("2026-08-14T16:02:01.000Z"),
			}),
		).resolves.toEqual([]);
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "manual-replay-publisher",
				now: new Date("2026-08-14T16:04:00.001Z"),
			}),
		).resolves.toEqual([dispatch]);
	});

	it("rejects a replay past the pending deadline without auditing it", async () => {
		await expect(
			requestCanaryDispatchReplayTx(tdb.db, {
				dispatchId: campaign.dispatchId,
				requestedBy: "operator@example.com",
				now: new Date("2026-08-14T16:06:00.000Z"),
			}),
		).resolves.toBe(false);

		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "manual-replay-publisher",
				now: new Date("2026-08-14T16:06:01.000Z"),
			}),
		).resolves.toEqual([]);
		expect(
			await tdb.db
				.select({ requestedBy: canaryDispatchOutbox.replayRequestedBy })
				.from(canaryDispatchOutbox),
		).toEqual([{ requestedBy: null }]);
	});

	it("marks five-minute pending work inconclusive and initiates Campaign cleanup", async () => {
		await tdb.db
			.update(canaryDispatchOutbox)
			.set({ admittedAt: new Date("2026-08-14T15:54:59.000Z") })
			.where(eq(canaryDispatchOutbox.dispatchId, campaign.dispatchId));

		await expect(
			markOverdueCanaryDispatchesTx(tdb.db, {
				now: new Date("2026-08-14T16:00:00.000Z"),
			}),
		).resolves.toEqual({ campaignIds: [campaign.campaignId] });
		expect(
			await tdb.db
				.select({
					lifecycle: canaryCampaigns.lifecycle,
					provisionalVerdict: canaryCampaigns.provisionalVerdict,
					cleanupRequestedAt: canaryCampaigns.cleanupRequestedAt,
				})
				.from(canaryCampaigns),
		).toEqual([
			{
				lifecycle: "cleaning",
				provisionalVerdict: "inconclusive",
				cleanupRequestedAt: new Date("2026-08-14T16:00:00.000Z"),
			},
		]);
		await expect(
			claimCanaryDispatchesTx(tdb.db, {
				publisherId: "publisher-after-deadline",
				now: new Date("2026-08-14T16:00:01.000Z"),
			}),
		).resolves.toEqual([]);
	});

	it("marks a published but never acquired dispatch overdue", async () => {
		await tdb.db
			.update(canaryDispatchOutbox)
			.set({
				admittedAt: new Date("2026-08-14T15:54:59.000Z"),
				publishedAt: new Date("2026-08-14T15:55:00.000Z"),
			})
			.where(eq(canaryDispatchOutbox.dispatchId, campaign.dispatchId));

		await expect(
			markOverdueCanaryDispatchesTx(tdb.db, {
				now: new Date("2026-08-14T16:00:00.000Z"),
			}),
		).resolves.toEqual({ campaignIds: [campaign.campaignId] });
		expect(
			await tdb.db
				.select({ lifecycle: canaryCampaigns.lifecycle })
				.from(canaryCampaigns),
		).toEqual([{ lifecycle: "cleaning" }]);
	});
});
