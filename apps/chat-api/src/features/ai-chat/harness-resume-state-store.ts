import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
import type { Database } from "@mymemo/agent-db/client";
import { conversationRuntime } from "@mymemo/agent-db/schema";
import { and, eq } from "drizzle-orm";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

/**
 * The Conversation's opaque Harness resume pointer (ADR-0033): whatever
 * `session.stop()` returned after the last turn, handed back verbatim as
 * `createSession({ resumeFrom })`. chat-api never reads inside it — the
 * Conversation's memory is the sandbox snapshot, not this value.
 */
export interface HarnessResumeStateStore {
	load(ref: ConversationRef): Promise<HarnessAgentResumeSessionState | null>;
	save(
		ref: ConversationRef,
		state: HarnessAgentResumeSessionState,
	): Promise<void>;
}

/**
 * Stores the pointer on `conversation_runtime`. Unfenced on purpose: the AI SDK
 * chat path has no Run and no Conversation Ownership, so there is no epoch to
 * fence on; the `(user_id, conversation_id)` key is the only guard.
 */
export class PostgresHarnessResumeStateStore
	implements HarnessResumeStateStore
{
	constructor(private readonly db: Database) {}

	async load(
		ref: ConversationRef,
	): Promise<HarnessAgentResumeSessionState | null> {
		const [row] = await this.db
			.select({ state: conversationRuntime.harnessResumeState })
			.from(conversationRuntime)
			.where(
				and(
					eq(conversationRuntime.userId, ref.userId),
					eq(conversationRuntime.conversationId, ref.conversationId),
				),
			);
		return (row?.state as HarnessAgentResumeSessionState | undefined) ?? null;
	}

	async save(
		ref: ConversationRef,
		state: HarnessAgentResumeSessionState,
	): Promise<void> {
		await this.db
			.insert(conversationRuntime)
			.values({ ...ref, harnessResumeState: state })
			.onConflictDoUpdate({
				target: [
					conversationRuntime.userId,
					conversationRuntime.conversationId,
				],
				set: { harnessResumeState: state, updatedAt: new Date() },
			});
	}
}
