import {
	ActiveRunConflictError,
	isActiveRunConflict,
	type RunCancellationResult,
	type RunRecord,
	requestRunCancellationTx,
	toRunRecord,
} from "@mymemo/agent-db/run-store";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "@/db/client";
import { runEvents, runs } from "@/db/schema";
import type { ConversationRecord } from "@/features/conversation-store";
import { RunEventType } from "@/features/run-events";

/**
 * chat-api's run-store surface. The concurrency-critical transaction helpers
 * (claim, append, terminal, heartbeat, cancel, stale recovery) and their types
 * live in the shared `@mymemo/agent-db` package, so chat-api and agent-worker
 * run one implementation of the queue protocol over the same `runs`/`run_events`
 * tables. They are re-exported here so the feature barrel and existing
 * `@/features/run-store` importers see an unchanged surface. What stays
 * chat-api-specific is run *admission* — inserting the queued run and writing the
 * `run_started` event that carries the frozen conversation scope — plus the
 * `PostgresRunStore` read surface the routes and SSE projector consume.
 */

// Locally-bound helpers/types (used by this module's admission code) are
// re-exported through their import binding; the rest are pure pass-throughs.
export { ActiveRunConflictError, requestRunCancellationTx };
export type { RunCancellationResult, RunRecord };
export type {
	RunEventAppendClass,
	RunEventPayload,
	RunStatus,
	TerminalRunStatus,
} from "@mymemo/agent-db/run-store";
export {
	appendRunEventTx,
	claimNextRunTx,
	createQueuedRunTx,
	heartbeatRunTx,
	markStaleRunsTx,
	RunFenceError,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";

/**
 * Queue admission failed: the conversation already has an active
 * (queued/running/cancel_requested) run. A specialization of the shared
 * {@link ActiveRunConflictError} so the route can surface busy/backpressure with
 * a stable message; the partial unique index is the authority.
 */
export class ActiveRunExistsError extends ActiveRunConflictError {
	override name = "ActiveRunExistsError" as const;
	constructor(options?: ErrorOptions) {
		super("Conversation already has an active run", options);
	}
}

export interface CreateQueuedRunInput {
	conversation: ConversationRecord;
	message: string;
	/** A Live subscription may be prepared for this id before admission. */
	runId?: string;
}

export interface CreateQueuedRunResult {
	runId: string;
}

export interface RunEventRecord {
	runId: string;
	seq: number;
	type: string;
	payload: unknown;
}

export interface RunStore {
	createQueuedRun(input: CreateQueuedRunInput): Promise<CreateQueuedRunResult>;
	getRun(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunRecord | null>;
	/** Record a user cancellation request for an owned run
	 * (see {@link requestRunCancellationTx}). */
	requestCancellation(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunCancellationResult>;
}

/**
 * Insert one `queued` run and its `run_started` event in a single transaction.
 * `run_started` (seq 1) records the frozen conversation scope so the worker
 * reads it from the durable log, never from the turn body. The
 * `runs_one_active_per_conversation` partial unique index enforces
 * single-admission at the DB layer; a violation is mapped to
 * {@link ActiveRunExistsError}. Any other failure is rethrown untouched.
 */
export async function createQueuedRunStartedTx(
	db: Database,
	input: CreateQueuedRunInput & { runId: string },
): Promise<RunRecord> {
	const { conversation, message, runId } = input;
	try {
		return await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(runs)
				.values({
					runId,
					userId: conversation.userId,
					conversationId: conversation.conversationId,
					status: "queued",
					nextEventSeq: 2,
				})
				.returning();
			if (!row) throw new Error(`insert of run ${runId} returned no row`);
			await tx.insert(runEvents).values({
				runId,
				seq: 1,
				type: RunEventType.Started,
				payload: {
					userId: conversation.userId,
					conversationId: conversation.conversationId,
					runId,
					message,
					scope: conversation.scope,
					collectionId: conversation.collectionId,
					summaryId: conversation.summaryId,
				},
			});
			return toRunRecord(row);
		});
	} catch (error) {
		if (isActiveRunConflict(error)) {
			throw new ActiveRunExistsError({ cause: error });
		}
		throw error;
	}
}

export class PostgresRunStore implements RunStore {
	constructor(private readonly db: Database) {}

	async createQueuedRun(
		input: CreateQueuedRunInput,
	): Promise<CreateQueuedRunResult> {
		const runId = input.runId ?? crypto.randomUUID();
		await createQueuedRunStartedTx(this.db, { ...input, runId });
		return { runId };
	}

	async getRun(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunRecord | null> {
		const rows = await this.db
			.select()
			.from(runs)
			.where(
				and(
					eq(runs.userId, input.userId),
					eq(runs.conversationId, input.conversationId),
					eq(runs.runId, input.runId),
				),
			)
			.limit(1);
		return rows[0] ? toRunRecord(rows[0]) : null;
	}

	async requestCancellation(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunCancellationResult> {
		return requestRunCancellationTx(this.db, input);
	}

	async listRunEventsAfter(input: {
		runId: string;
		afterSeq: number;
	}): Promise<RunEventRecord[]> {
		return this.db
			.select({
				runId: runEvents.runId,
				seq: runEvents.seq,
				type: runEvents.type,
				payload: runEvents.payload,
			})
			.from(runEvents)
			.where(
				and(
					eq(runEvents.runId, input.runId),
					gt(runEvents.seq, input.afterSeq),
				),
			)
			.orderBy(runEvents.seq);
	}
}
