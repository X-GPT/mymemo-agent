import {
	and,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { Database, DbTx } from "./client";
import {
	type ConversationOwner,
	conversationOwnershipClock,
	conversationOwnershipLeaseDeadline,
	liveConversationOwnershipState,
} from "./conversation-ownership";
import { isTerminalRunStatus, type TerminalRunStatus } from "./run-store";
import {
	ACTIVE_RUN_STATUSES,
	agentCoreDispatchOutbox,
	conversations,
	runs,
} from "./schema";

const DISPATCH_PUBLISH_LEASE_MS = 3 * 60_000;
export const MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE = 10;

export interface AgentCoreDispatchIdentity {
	schemaVersion: 2;
	userId: string;
	conversationId: string;
	runId: string;
	runtimeSessionId: string;
	admittedAt: Date;
}

export type AcquireAgentCoreDispatchResult =
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
 * Add the Run-keyed dispatch record inside the caller's admission transaction.
 * The Run id primary key is the at-most-one-dispatch authority.
 */
export async function recordAgentCoreDispatchInTx(
	tx: DbTx,
	input: {
		userId: string;
		conversationId: string;
		runId: string;
		admittedAt?: Date;
	},
): Promise<void> {
	await tx.insert(agentCoreDispatchOutbox).values({
		userId: input.userId,
		conversationId: input.conversationId,
		runId: input.runId,
		admittedAt: input.admittedAt,
	});
}

/**
 * Claim a bounded batch of publishable outbox rows. The row locks and lease
 * update commit before the caller performs any SQS I/O; an unconfirmed send
 * deliberately leaves its lease to expire so the same Run can be replayed.
 */
export async function claimAgentCoreDispatchesTx(
	db: Database,
	input: {
		publisherId: string;
		runId?: string;
		now?: Date;
		limit?: number;
	},
): Promise<AgentCoreDispatchIdentity[]> {
	const now = input.now ?? new Date();
	const limit = Math.max(
		0,
		Math.min(
			input.limit ?? MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
			MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
		),
	);
	if (limit === 0) return [];

	return await db.transaction(async (tx) => {
		const candidates = await tx
			.select()
			.from(agentCoreDispatchOutbox)
			.where(
				and(
					input.runId
						? eq(agentCoreDispatchOutbox.runId, input.runId)
						: undefined,
					or(
						isNull(agentCoreDispatchOutbox.publishClaimUntil),
						lte(agentCoreDispatchOutbox.publishClaimUntil, now),
					),
					or(
						isNull(agentCoreDispatchOutbox.publishedAt),
						and(
							isNotNull(agentCoreDispatchOutbox.replayRequestedAt),
							sql`${agentCoreDispatchOutbox.replayRequestedAt} > ${agentCoreDispatchOutbox.publishedAt}`,
						),
					),
				),
			)
			.orderBy(
				agentCoreDispatchOutbox.admittedAt,
				agentCoreDispatchOutbox.runId,
			)
			.limit(limit)
			.for("update", { skipLocked: true });
		if (candidates.length === 0) return [];

		await tx
			.update(agentCoreDispatchOutbox)
			.set({
				publishClaimedBy: input.publisherId,
				publishClaimUntil: new Date(now.getTime() + DISPATCH_PUBLISH_LEASE_MS),
				publishAttempts: sql`${agentCoreDispatchOutbox.publishAttempts} + 1`,
			})
			.where(
				inArray(
					agentCoreDispatchOutbox.runId,
					candidates.map(({ runId }) => runId),
				),
			);

		return candidates.map((row) => ({
			schemaVersion: 2,
			userId: row.userId,
			conversationId: row.conversationId,
			runId: row.runId,
			runtimeSessionId: row.conversationId,
			admittedAt: row.admittedAt,
		}));
	});
}

/** Confirm one SQS send only while this publisher still owns the outbox lease. */
export async function confirmAgentCoreDispatchPublishedTx(
	db: Database,
	input: { runId: string; publisherId: string; now?: Date },
): Promise<boolean> {
	const now = input.now ?? new Date();
	const confirmed = await db
		.update(agentCoreDispatchOutbox)
		.set({
			publishedAt: now,
			publishClaimedBy: null,
			publishClaimUntil: null,
		})
		.where(
			and(
				eq(agentCoreDispatchOutbox.runId, input.runId),
				eq(agentCoreDispatchOutbox.publishClaimedBy, input.publisherId),
				gt(agentCoreDispatchOutbox.publishClaimUntil, now),
			),
		)
		.returning({ runId: agentCoreDispatchOutbox.runId });
	return confirmed.length > 0;
}

/** Audit an operator replay request without disturbing a live publish lease. */
export async function requestAgentCoreDispatchReplayTx(
	db: Database,
	input: { runId: string; requestedBy: string; now?: Date },
): Promise<boolean> {
	if (input.requestedBy.trim() === "") {
		throw new Error("manual replay requires an operator identity");
	}
	const replay = await db
		.update(agentCoreDispatchOutbox)
		.set({
			replayRequestedAt: input.now ?? new Date(),
			replayRequestedBy: input.requestedBy,
		})
		.where(eq(agentCoreDispatchOutbox.runId, input.runId))
		.returning({ runId: agentCoreDispatchOutbox.runId });
	return replay.length > 0;
}

/**
 * Acquire one exact AgentCore dispatch. The Conversation is locked before its
 * Run to preserve the global Ownership lock order. Ownership establishment and
 * queued-to-running transition share this commit. A queued dispatch must name
 * the Conversation's oldest Active Run, making the depth-one admission
 * assumption an explicit acquisition invariant.
 */
export async function acquireAgentCoreDispatchTx(
	db: Database,
	input: {
		dispatch: AgentCoreDispatchIdentity;
		workerId: string;
		now?: Date;
	},
): Promise<AcquireAgentCoreDispatchResult> {
	return await db.transaction(async (tx) => {
		const [conversation] = await tx
			.select({
				userId: conversations.userId,
				conversationId: conversations.conversationId,
				epoch: conversations.epoch,
				ownerWorkerId: conversations.ownerWorkerId,
				ownerUntil: conversations.ownerUntil,
				hasLiveOwnership: liveConversationOwnershipState(input.now),
			})
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
			.from(agentCoreDispatchOutbox)
			.where(eq(agentCoreDispatchOutbox.runId, input.dispatch.runId))
			.limit(1);
		if (
			!run ||
			!outbox ||
			outbox.userId !== input.dispatch.userId ||
			outbox.conversationId !== input.dispatch.conversationId ||
			outbox.admittedAt.getTime() !== input.dispatch.admittedAt.getTime()
		) {
			return { disposition: "invalid_dispatch" };
		}
		if (
			(run.status === "running" || run.status === "interrupt_requested") &&
			conversation.hasLiveOwnership &&
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
			(run.status === "queued" &&
				(conversation.ownerWorkerId !== null ||
					conversation.ownerUntil !== null))
		) {
			return { disposition: "temporarily_unavailable" };
		}
		if (isTerminalRunStatus(run.status)) {
			return { disposition: "terminal", status: run.status };
		}

		const [oldestActive] = await tx
			.select({ runId: runs.runId })
			.from(runs)
			.where(
				and(
					eq(runs.userId, input.dispatch.userId),
					eq(runs.conversationId, input.dispatch.conversationId),
					inArray(runs.status, ACTIVE_RUN_STATUSES),
				),
			)
			.orderBy(runs.createdAt, runs.runId)
			.limit(1)
			.for("update");
		if (oldestActive?.runId !== input.dispatch.runId) {
			return { disposition: "invalid_dispatch" };
		}

		const epoch = conversation.epoch + 1;
		await tx
			.update(conversations)
			.set({
				epoch,
				ownerWorkerId: input.workerId,
				ownerUntil: conversationOwnershipLeaseDeadline(input.now),
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
				updatedAt: conversationOwnershipClock(input.now),
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
