import {
	ActiveRunConflictError,
	admitQueuedRunInTx,
	isActiveRunConflict,
	type RunAdmissionResult,
	type RunInterruptionResult,
	type RunRecord,
	requestRunInterruptionTx,
	toRunRecord,
} from "@mymemo/agent-db/run-store";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { conversations, runs } from "@/db/schema";
import type { ConversationRef } from "@/features/conversation-store";

/**
 * chat-api's run-store surface. The concurrency-critical transaction helpers
 * (start, append, terminal, and interrupt) and their types
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
export { ActiveRunConflictError, requestRunInterruptionTx };
export type { RunInterruptionResult, RunRecord };
export type {
	AdmitQueuedRunInput,
	MarkLiveStreamFailedResult,
	NormalizedRunInput,
	NormalizedRunInputV1,
	RunAdmissionResult,
	RunEventAppendClass,
	RunEventPayload,
	RunStatus,
	TerminalRunStatus,
} from "@mymemo/agent-db/run-store";
export {
	admitQueuedRunTx,
	appendRunEventTx,
	markLiveStreamFailedTx,
	RunInputMismatchError,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";

/**
 * Queue admission failed: the conversation already has an active
 * (queued/running/interrupt_requested) run. A specialization of the shared
 * {@link ActiveRunConflictError} so the route can surface busy/backpressure with
 * a stable message; admission's Active Run count, taken under the Conversation
 * row lock this module holds, is the authority.
 */
export class ActiveRunExistsError extends ActiveRunConflictError {
	override name = "ActiveRunExistsError" as const;
	constructor(options?: ErrorOptions) {
		super("Conversation already has an active run", options);
	}
}

/** Admission lost a lifecycle race with Archive. */
export class ConversationArchivedError extends Error {
	override name = "ConversationArchivedError" as const;
}

/** Admission lost a lifecycle race with Permanent deletion. */
export class ConversationNotFoundError extends Error {
	override name = "ConversationNotFoundError" as const;
}

export interface AdmitRunInput {
	conversation: ConversationRef;
	runId: string;
	messageId: string;
	message: string;
}

export interface RunStore {
	admitRun(input: AdmitRunInput): Promise<RunAdmissionResult>;
	getRun(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunRecord | null>;
	/** Record a user interruption request for an owned run
	 * (see {@link requestRunInterruptionTx}). */
	requestInterruption(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunInterruptionResult>;
}

/** Admit a canonical AG-UI Run while holding the same Conversation row lock as
 * Archive and Permanent deletion. The frozen Scope and lifecycle metadata are
 * read and updated inside this transaction, never trusted from the request. */
export async function admitRunTx(
	db: Database,
	input: AdmitRunInput,
): Promise<RunAdmissionResult> {
	try {
		return await db.transaction(async (tx) => {
			const [conversation] = await tx
				.select()
				.from(conversations)
				.where(
					and(
						eq(conversations.userId, input.conversation.userId),
						eq(conversations.conversationId, input.conversation.conversationId),
					),
				)
				.for("update");
			if (!conversation) {
				throw new ConversationNotFoundError(
					`Conversation ${input.conversation.conversationId} does not exist`,
				);
			}
			if (conversation.archivedAt !== null) {
				throw new ConversationArchivedError(
					`Conversation ${input.conversation.conversationId} is archived`,
				);
			}

			const admission = await admitQueuedRunInTx(tx, {
				runId: input.runId,
				userId: conversation.userId,
				conversationId: conversation.conversationId,
				messageId: input.messageId,
				text: input.message,
				scope: conversation.scope as "general" | "collection" | "document",
				collectionId: conversation.collectionId,
				summaryId: conversation.summaryId,
			});
			if (admission.outcome === "created") {
				await tx
					.update(conversations)
					.set({
						title: sql`coalesce(${conversations.title}, ${input.message})`,
						lastActivityAt: sql`now()`,
					})
					.where(
						and(
							eq(conversations.userId, conversation.userId),
							eq(conversations.conversationId, conversation.conversationId),
						),
					);
			}
			return admission;
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

	async admitRun(input: AdmitRunInput): Promise<RunAdmissionResult> {
		return admitRunTx(this.db, input);
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

	async requestInterruption(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunInterruptionResult> {
		return requestRunInterruptionTx(this.db, input);
	}
}
