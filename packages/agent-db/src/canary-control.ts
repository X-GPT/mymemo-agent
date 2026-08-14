import { and, eq, inArray, lte, ne } from "drizzle-orm";
import {
	CANARY_CAMPAIGN_LIFECYCLES,
	type CanaryCampaignLifecycle,
	type CanaryVerdict,
} from "./canary";
import type { Database, DbTx } from "./client";
import { AGENTCORE_CANARY_EXECUTION_LANE } from "./execution-lane";
import { assertAgentCoreCanaryCreationReady } from "./execution-lane-deployment";
import { admitQueuedRunInTx } from "./run-store";
import { canaryCampaigns, canaryDispatchOutbox, conversations } from "./schema";

export interface StartCanaryCampaignInput {
	campaignId: string;
	idempotencyKey: string;
	campaignVersion: string;
	fixtureVersion: string;
	fixtureChecksum: string;
	model: string;
	scenarioId: string;
	userId: string;
	conversationId: string;
	collectionId: string;
	runId: string;
	messageId: string;
	dispatchId: string;
	prompt: string;
}

export type CanaryCampaignRecord = typeof canaryCampaigns.$inferSelect;

export type StartCanaryCampaignResult =
	| { outcome: "created" | "existing"; campaign: CanaryCampaignRecord }
	| { outcome: "active_campaign"; campaign: CanaryCampaignRecord };

export async function findCanaryCampaignByIdempotencyKey(
	db: Database,
	idempotencyKey: string,
): Promise<CanaryCampaignRecord | null> {
	const [campaign] = await db
		.select()
		.from(canaryCampaigns)
		.where(eq(canaryCampaigns.idempotencyKey, idempotencyKey))
		.limit(1);
	return campaign ?? null;
}

export async function findActiveCanaryCampaign(
	db: Database,
): Promise<CanaryCampaignRecord | null> {
	const [campaign] = await db
		.select()
		.from(canaryCampaigns)
		.where(ne(canaryCampaigns.lifecycle, "complete"))
		.limit(1);
	return campaign ?? null;
}

export type AdvanceCanaryCampaignResult =
	| ({ outcome: "advanced" } & CanaryCampaignRecord)
	| { outcome: "stale" };

/**
 * Monotonic compare-and-set for Campaign lifecycle. Forward skips are legal so
 * a failed preparation or Run can enter cleanup without manufacturing the
 * intervening states; moving backward or attaching a verdict before completion
 * is refused.
 */
export async function advanceCanaryCampaignTx(
	db: Database,
	input: {
		campaignId: string;
		expectedLifecycle: CanaryCampaignLifecycle;
		lifecycle: CanaryCampaignLifecycle;
		verdict?: CanaryVerdict;
	},
): Promise<AdvanceCanaryCampaignResult> {
	const from = CANARY_CAMPAIGN_LIFECYCLES.indexOf(input.expectedLifecycle);
	const to = CANARY_CAMPAIGN_LIFECYCLES.indexOf(input.lifecycle);
	if (to <= from) {
		throw new Error("Canary Campaign lifecycle must advance monotonically");
	}
	if (input.lifecycle === "complete" && input.verdict === undefined) {
		throw new Error("a completed Canary Campaign requires a verdict");
	}
	if (input.lifecycle !== "complete" && input.verdict !== undefined) {
		throw new Error("a Canary verdict is legal only at completion");
	}

	const [advanced] = await db
		.update(canaryCampaigns)
		.set({
			lifecycle: input.lifecycle,
			verdict: input.verdict,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(canaryCampaigns.campaignId, input.campaignId),
				eq(canaryCampaigns.lifecycle, input.expectedLifecycle),
			),
		)
		.returning();
	return advanced ? { outcome: "advanced", ...advanced } : { outcome: "stale" };
}

/** Remove completed Campaign/outbox audit only after its 30-day deadline. */
export async function expireCanaryAuditRecordsTx(
	db: Database,
	input: { now?: Date } = {},
): Promise<{ campaignsDeleted: number; dispatchesDeleted: number }> {
	const now = input.now ?? new Date();
	return await db.transaction(async (tx) => {
		const expired = await tx
			.select({ campaignId: canaryCampaigns.campaignId })
			.from(canaryCampaigns)
			.where(
				and(
					eq(canaryCampaigns.lifecycle, "complete"),
					lte(canaryCampaigns.expiresAt, now),
				),
			)
			.for("update");
		const campaignIds = expired.map(({ campaignId }) => campaignId);
		if (campaignIds.length === 0) {
			return { campaignsDeleted: 0, dispatchesDeleted: 0 };
		}
		const dispatches = await tx
			.delete(canaryDispatchOutbox)
			.where(
				and(
					inArray(canaryDispatchOutbox.campaignId, campaignIds),
					lte(canaryDispatchOutbox.expiresAt, now),
				),
			)
			.returning({ dispatchId: canaryDispatchOutbox.dispatchId });
		const campaigns = await tx
			.delete(canaryCampaigns)
			.where(inArray(canaryCampaigns.campaignId, campaignIds))
			.returning({ campaignId: canaryCampaigns.campaignId });
		return {
			campaignsDeleted: campaigns.length,
			dispatchesDeleted: dispatches.length,
		};
	});
}

export class CanaryAdmissionError extends Error {
	override name = "CanaryAdmissionError" as const;
}

export class CanaryCampaignInputMismatchError extends Error {
	override name = "CanaryCampaignInputMismatchError" as const;
}

function campaignMatchesInput(
	campaign: CanaryCampaignRecord,
	input: StartCanaryCampaignInput,
): boolean {
	return (
		campaign.campaignId === input.campaignId &&
		campaign.campaignVersion === input.campaignVersion &&
		campaign.fixtureVersion === input.fixtureVersion &&
		campaign.fixtureChecksum === input.fixtureChecksum &&
		campaign.model === input.model &&
		campaign.scenarioId === input.scenarioId &&
		campaign.userId === input.userId &&
		campaign.conversationId === input.conversationId &&
		campaign.runId === input.runId &&
		campaign.messageId === input.messageId
	);
}

function requireCampaignMatchesInput(
	campaign: CanaryCampaignRecord,
	input: StartCanaryCampaignInput,
): void {
	if (!campaignMatchesInput(campaign, input)) {
		throw new CanaryCampaignInputMismatchError(
			"idempotency key is already bound to different Canary Campaign input",
		);
	}
}

export type CanaryScenarioAdmissionResult = {
	outcome: "created" | "existing";
};

/**
 * Standalone form of the transactional Canary admission seam. It is retryable
 * with the same deterministic identities; only a newly admitted Run receives
 * an outbox row, and both writes share one commit.
 */
export async function admitCanaryScenarioTx(
	db: Database,
	input: StartCanaryCampaignInput,
): Promise<CanaryScenarioAdmissionResult> {
	return await db.transaction(
		async (tx) => await admitCanaryScenarioInTx(tx, input),
	);
}

async function admitCanaryScenarioInTx(
	tx: DbTx,
	input: StartCanaryCampaignInput,
): Promise<CanaryScenarioAdmissionResult> {
	const [campaign] = await tx
		.select()
		.from(canaryCampaigns)
		.where(eq(canaryCampaigns.campaignId, input.campaignId))
		.for("update");
	if (!campaign || campaign.lifecycle === "complete") {
		throw new CanaryAdmissionError(
			"Canary scenario does not match an active configured Campaign",
		);
	}
	requireCampaignMatchesInput(campaign, input);

	const [conversation] = await tx
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, input.userId),
				eq(conversations.conversationId, input.conversationId),
			),
		)
		.for("update");
	if (
		!conversation ||
		conversation.archivedAt !== null ||
		conversation.executionLane !== AGENTCORE_CANARY_EXECUTION_LANE ||
		conversation.scope !== "collection" ||
		conversation.collectionId !== input.collectionId ||
		conversation.summaryId !== null
	) {
		throw new CanaryAdmissionError(
			"Canary scenario Conversation is missing, archived, or misconfigured",
		);
	}

	const admission = await admitQueuedRunInTx(tx, {
		runId: input.runId,
		userId: input.userId,
		conversationId: input.conversationId,
		messageId: input.messageId,
		text: input.prompt,
		scope: "collection",
		collectionId: input.collectionId,
		summaryId: null,
	});
	if (admission.outcome === "not_found") {
		throw new CanaryAdmissionError(
			"Canary scenario Run identity belongs to another Conversation",
		);
	}
	if (admission.outcome === "existing") {
		const [outbox] = await tx
			.select()
			.from(canaryDispatchOutbox)
			.where(eq(canaryDispatchOutbox.runId, input.runId))
			.limit(1);
		if (
			!outbox ||
			outbox.dispatchId !== input.dispatchId ||
			outbox.campaignId !== input.campaignId ||
			outbox.scenarioId !== input.scenarioId ||
			outbox.userId !== input.userId ||
			outbox.conversationId !== input.conversationId
		) {
			throw new CanaryAdmissionError(
				"existing Canary Run is missing its exact dispatch audit",
			);
		}
		return { outcome: "existing" };
	}

	await tx.insert(canaryDispatchOutbox).values({
		dispatchId: input.dispatchId,
		campaignId: input.campaignId,
		scenarioId: input.scenarioId,
		userId: input.userId,
		conversationId: input.conversationId,
		runId: input.runId,
		executionLane: AGENTCORE_CANARY_EXECUTION_LANE,
		expiresAt: campaign.expiresAt,
	});
	return { outcome: "created" };
}

/**
 * Create the first configured scenario and its pending dispatch in one commit.
 * The caller supplies only trusted, configuration-derived values; the operator
 * request boundary lives above this shared database behavior.
 */
export async function startCanaryCampaignTx(
	db: Database,
	input: StartCanaryCampaignInput,
): Promise<StartCanaryCampaignResult> {
	return await db.transaction(async (tx) => {
		const [sameKey] = await tx
			.select()
			.from(canaryCampaigns)
			.where(eq(canaryCampaigns.idempotencyKey, input.idempotencyKey))
			.limit(1);
		if (sameKey) {
			requireCampaignMatchesInput(sameKey, input);
			return { outcome: "existing", campaign: sameKey };
		}

		await assertAgentCoreCanaryCreationReady(tx);
		const [createdCampaign] = await tx
			.insert(canaryCampaigns)
			.values({
				campaignId: input.campaignId,
				idempotencyKey: input.idempotencyKey,
				campaignVersion: input.campaignVersion,
				fixtureVersion: input.fixtureVersion,
				fixtureChecksum: input.fixtureChecksum,
				model: input.model,
				scenarioId: input.scenarioId,
				userId: input.userId,
				conversationId: input.conversationId,
				runId: input.runId,
				messageId: input.messageId,
			})
			.onConflictDoNothing()
			.returning();
		if (!createdCampaign) {
			const [reattached] = await tx
				.select()
				.from(canaryCampaigns)
				.where(eq(canaryCampaigns.idempotencyKey, input.idempotencyKey))
				.limit(1);
			if (reattached) {
				requireCampaignMatchesInput(reattached, input);
				return { outcome: "existing", campaign: reattached };
			}
			const [active] = await tx
				.select()
				.from(canaryCampaigns)
				.where(ne(canaryCampaigns.lifecycle, "complete"))
				.limit(1);
			if (!active) {
				throw new Error(
					"canary Campaign insertion conflicted without an active Campaign",
				);
			}
			return { outcome: "active_campaign", campaign: active };
		}

		await tx.insert(conversations).values({
			userId: input.userId,
			conversationId: input.conversationId,
			scope: "collection",
			collectionId: input.collectionId,
			summaryId: null,
			executionLane: AGENTCORE_CANARY_EXECUTION_LANE,
		});
		await admitCanaryScenarioInTx(tx, input);
		return { outcome: "created", campaign: createdCampaign };
	});
}
