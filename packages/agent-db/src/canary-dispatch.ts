import {
	and,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	ne,
	or,
	sql,
} from "drizzle-orm";
import type { Database } from "./client";
import type { ConversationOwner } from "./conversation-ownership";
import { AGENTCORE_CANARY_EXECUTION_LANE } from "./execution-lane";
import type { TerminalRunStatus } from "./run-store";
import {
	canaryCampaigns,
	canaryDispatchOutbox,
	conversations,
	runs,
} from "./schema";

const AGENTCORE_OWNERSHIP_LEASE_MS = 60_000;
const DISPATCH_PUBLISH_LEASE_MS = 3 * 60_000;
const DISPATCH_PENDING_DEADLINE_MS = 5 * 60_000;
const MAX_PUBLISH_BATCH_SIZE = 10;

export interface CanaryDispatchIdentity {
	schemaVersion: 1;
	dispatchId: string;
	campaignId: string;
	scenarioId: string;
	userId: string;
	conversationId: string;
	runId: string;
	runtimeSessionId: string;
	expectedExecutionLane: typeof AGENTCORE_CANARY_EXECUTION_LANE;
	admittedAt: Date;
}

export type AcquireCanaryDispatchResult =
	| {
			disposition: "acquired";
			owner: ConversationOwner;
			workerId: string;
	  }
	| {
			disposition: "already_acquired";
			owner: ConversationOwner;
			workerId: string;
	  }
	| { disposition: "terminal"; status: TerminalRunStatus }
	| { disposition: "temporarily_unavailable" }
	| { disposition: "invalid_dispatch" };

/**
 * Claim a bounded batch of publishable outbox rows. The row locks and lease
 * update commit before the caller performs any SQS I/O; an unconfirmed send
 * deliberately leaves its lease to expire so the same dispatch can be replayed.
 */
export async function claimCanaryDispatchesTx(
	db: Database,
	input: { publisherId: string; now?: Date; limit?: number },
): Promise<CanaryDispatchIdentity[]> {
	const now = input.now ?? new Date();
	const limit = Math.max(
		0,
		Math.min(input.limit ?? MAX_PUBLISH_BATCH_SIZE, MAX_PUBLISH_BATCH_SIZE),
	);
	if (limit === 0) return [];

	return await db.transaction(async (tx) => {
		// Campaign lifecycle always precedes its outbox in the Canary lock order.
		// The shared lock prevents completion/cleanup from racing a publish claim.
		const activeCampaigns = await tx
			.select({ campaignId: canaryCampaigns.campaignId })
			.from(canaryCampaigns)
			.where(
				inArray(canaryCampaigns.lifecycle, [
					"preparing",
					"provisioning",
					"running",
				]),
			)
			.for("share");
		const activeCampaignIds = activeCampaigns.map(
			({ campaignId }) => campaignId,
		);
		if (activeCampaignIds.length === 0) return [];

		const candidates = await tx
			.select()
			.from(canaryDispatchOutbox)
			.where(
				and(
					inArray(canaryDispatchOutbox.campaignId, activeCampaignIds),
					gt(
						canaryDispatchOutbox.admittedAt,
						new Date(now.getTime() - DISPATCH_PENDING_DEADLINE_MS),
					),
					gt(canaryDispatchOutbox.expiresAt, now),
					or(
						isNull(canaryDispatchOutbox.publishClaimUntil),
						lte(canaryDispatchOutbox.publishClaimUntil, now),
					),
					or(
						isNull(canaryDispatchOutbox.publishedAt),
						and(
							isNotNull(canaryDispatchOutbox.replayRequestedAt),
							sql`${canaryDispatchOutbox.replayRequestedAt} > ${canaryDispatchOutbox.publishedAt}`,
						),
					),
				),
			)
			.orderBy(canaryDispatchOutbox.admittedAt, canaryDispatchOutbox.dispatchId)
			.limit(limit)
			.for("update", { skipLocked: true });
		if (candidates.length === 0) return [];

		await tx
			.update(canaryDispatchOutbox)
			.set({
				publishClaimedBy: input.publisherId,
				publishClaimUntil: new Date(now.getTime() + DISPATCH_PUBLISH_LEASE_MS),
				publishAttempts: sql`${canaryDispatchOutbox.publishAttempts} + 1`,
			})
			.where(
				inArray(
					canaryDispatchOutbox.dispatchId,
					candidates.map(({ dispatchId }) => dispatchId),
				),
			);

		return candidates.map((row) => ({
			schemaVersion: 1,
			dispatchId: row.dispatchId,
			campaignId: row.campaignId,
			scenarioId: row.scenarioId,
			userId: row.userId,
			conversationId: row.conversationId,
			runId: row.runId,
			runtimeSessionId: row.conversationId,
			expectedExecutionLane: AGENTCORE_CANARY_EXECUTION_LANE,
			admittedAt: row.admittedAt,
		}));
	});
}

/** Confirm one SQS send only while this publisher still owns the outbox lease. */
export async function confirmCanaryDispatchPublishedTx(
	db: Database,
	input: {
		dispatchId: string;
		publisherId: string;
		now?: Date;
	},
): Promise<boolean> {
	const confirmed = await db
		.update(canaryDispatchOutbox)
		.set({
			publishedAt: input.now ?? new Date(),
			publishClaimedBy: null,
			publishClaimUntil: null,
		})
		.where(
			and(
				eq(canaryDispatchOutbox.dispatchId, input.dispatchId),
				eq(canaryDispatchOutbox.publishClaimedBy, input.publisherId),
			),
		)
		.returning({ dispatchId: canaryDispatchOutbox.dispatchId });
	return confirmed.length > 0;
}

/** Audit an operator replay request without changing any dispatch identity. */
export async function requestCanaryDispatchReplayTx(
	db: Database,
	input: { dispatchId: string; requestedBy: string; now?: Date },
): Promise<boolean> {
	if (input.requestedBy.trim() === "") {
		throw new Error("manual replay requires an operator identity");
	}
	const replay = await db
		.update(canaryDispatchOutbox)
		.set({
			replayRequestedAt: input.now ?? new Date(),
			replayRequestedBy: input.requestedBy,
			publishClaimedBy: null,
			publishClaimUntil: null,
		})
		.where(eq(canaryDispatchOutbox.dispatchId, input.dispatchId))
		.returning({ dispatchId: canaryDispatchOutbox.dispatchId });
	return replay.length > 0;
}

/**
 * Turn a dispatch that never reached a confirmed first publication within five
 * minutes into an inconclusive Campaign cleanup request. The final verdict is
 * still written only after cleanup/reporting completes.
 */
export async function markOverdueCanaryDispatchesTx(
	db: Database,
	input: { now?: Date } = {},
): Promise<{ campaignIds: string[] }> {
	const now = input.now ?? new Date();
	return await db.transaction(async (tx) => {
		// Match every other Campaign/outbox mutation: Campaign first, then outbox.
		// This also prevents two repair invocations from marking the same Campaign.
		const campaigns = await tx
			.select({ campaignId: canaryCampaigns.campaignId })
			.from(canaryCampaigns)
			.where(
				and(
					inArray(canaryCampaigns.lifecycle, [
						"preparing",
						"provisioning",
						"running",
					]),
					sql`exists (
						select 1 from ${canaryDispatchOutbox} dispatch
						where dispatch.campaign_id = ${canaryCampaigns.campaignId}
						  and dispatch.published_at is null
						  and dispatch.admitted_at <= ${new Date(now.getTime() - DISPATCH_PENDING_DEADLINE_MS)}
					)`,
				),
			)
			.for("update", { skipLocked: true });
		const candidateCampaignIds = campaigns.map(({ campaignId }) => campaignId);
		if (candidateCampaignIds.length === 0) return { campaignIds: [] };

		const overdue = await tx
			.select({ dispatchId: canaryDispatchOutbox.dispatchId })
			.from(canaryDispatchOutbox)
			.where(
				and(
					inArray(canaryDispatchOutbox.campaignId, candidateCampaignIds),
					isNull(canaryDispatchOutbox.publishedAt),
					lte(
						canaryDispatchOutbox.admittedAt,
						new Date(now.getTime() - DISPATCH_PENDING_DEADLINE_MS),
					),
				),
			)
			.for("update");
		if (overdue.length === 0) return { campaignIds: [] };

		const marked = await tx
			.update(canaryCampaigns)
			.set({
				lifecycle: "cleaning",
				provisionalVerdict: "inconclusive",
				cleanupRequestedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					inArray(canaryCampaigns.campaignId, candidateCampaignIds),
					ne(canaryCampaigns.lifecycle, "cleaning"),
					ne(canaryCampaigns.lifecycle, "complete"),
				),
			)
			.returning({ campaignId: canaryCampaigns.campaignId });
		return {
			campaignIds: marked.map(({ campaignId }) => campaignId).sort(),
		};
	});
}

/**
 * Acquire one exact AgentCore dispatch. The Campaign is locked first to match
 * Canary admission, then the Conversation before its Run to preserve the
 * global ownership lock order. Ownership and queued-to-running transition
 * share this commit, so neither fact can exist without the other.
 */
export async function acquireCanaryDispatchTx(
	db: Database,
	input: {
		dispatch: CanaryDispatchIdentity;
		workerId: string;
		now?: Date;
	},
): Promise<AcquireCanaryDispatchResult> {
	const now = input.now ?? new Date();
	return await db.transaction(async (tx) => {
		const [campaign] = await tx
			.select()
			.from(canaryCampaigns)
			.where(eq(canaryCampaigns.campaignId, input.dispatch.campaignId))
			.for("update");
		if (
			!campaign ||
			campaign.scenarioId !== input.dispatch.scenarioId ||
			campaign.userId !== input.dispatch.userId ||
			campaign.conversationId !== input.dispatch.conversationId ||
			campaign.runId !== input.dispatch.runId
		) {
			return { disposition: "invalid_dispatch" };
		}

		const [conversation] = await tx
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, input.dispatch.userId),
					eq(conversations.conversationId, input.dispatch.conversationId),
				),
			)
			.for("update");
		if (
			!conversation ||
			conversation.executionLane !== AGENTCORE_CANARY_EXECUTION_LANE ||
			input.dispatch.expectedExecutionLane !==
				AGENTCORE_CANARY_EXECUTION_LANE ||
			input.dispatch.runtimeSessionId !== input.dispatch.conversationId
		) {
			return { disposition: "invalid_dispatch" };
		}

		const [run] = await tx
			.select()
			.from(runs)
			.where(
				and(
					eq(runs.runId, input.dispatch.runId),
					eq(runs.userId, input.dispatch.userId),
					eq(runs.conversationId, input.dispatch.conversationId),
				),
			)
			.for("update");
		const [outbox] = await tx
			.select()
			.from(canaryDispatchOutbox)
			.where(eq(canaryDispatchOutbox.dispatchId, input.dispatch.dispatchId))
			.limit(1);
		if (
			!run ||
			!outbox ||
			outbox.campaignId !== input.dispatch.campaignId ||
			outbox.scenarioId !== input.dispatch.scenarioId ||
			outbox.userId !== input.dispatch.userId ||
			outbox.conversationId !== input.dispatch.conversationId ||
			outbox.runId !== input.dispatch.runId ||
			outbox.executionLane !== input.dispatch.expectedExecutionLane ||
			outbox.admittedAt.getTime() !== input.dispatch.admittedAt.getTime()
		) {
			return { disposition: "invalid_dispatch" };
		}
		if (
			(run.status === "running" || run.status === "interrupt_requested") &&
			conversation.ownerUntil !== null &&
			conversation.ownerUntil.getTime() > now.getTime() &&
			conversation.ownerWorkerId !== null
		) {
			return {
				disposition: "already_acquired",
				owner: {
					userId: conversation.userId,
					conversationId: conversation.conversationId,
					epoch: conversation.epoch,
				},
				workerId: conversation.ownerWorkerId,
			};
		}
		if (
			run.status === "running" ||
			run.status === "interrupt_requested" ||
			(run.status === "queued" && conversation.ownerUntil !== null)
		) {
			return { disposition: "temporarily_unavailable" };
		}
		if (
			run.status === "done" ||
			run.status === "error" ||
			run.status === "interrupted"
		) {
			return { disposition: "terminal", status: run.status };
		}
		if (
			campaign.lifecycle === "cleaning" ||
			campaign.lifecycle === "complete"
		) {
			return { disposition: "temporarily_unavailable" };
		}
		if (run.status !== "queued") {
			return { disposition: "invalid_dispatch" };
		}

		const epoch = conversation.epoch + 1;
		await tx
			.update(conversations)
			.set({
				epoch,
				ownerWorkerId: input.workerId,
				ownerUntil: new Date(now.getTime() + AGENTCORE_OWNERSHIP_LEASE_MS),
			})
			.where(
				and(
					eq(conversations.userId, input.dispatch.userId),
					eq(conversations.conversationId, input.dispatch.conversationId),
				),
			);
		await tx
			.update(runs)
			.set({
				status: "running",
				executedByWorkerId: input.workerId,
				updatedAt: now,
			})
			.where(eq(runs.runId, input.dispatch.runId));

		return {
			disposition: "acquired",
			owner: {
				userId: input.dispatch.userId,
				conversationId: input.dispatch.conversationId,
				epoch,
			},
			workerId: input.workerId,
		};
	});
}
