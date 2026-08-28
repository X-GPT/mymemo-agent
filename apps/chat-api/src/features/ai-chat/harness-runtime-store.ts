import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
import type { Database } from "@mymemo/agent-db/client";
import { loadConversationRuntimeTx } from "@mymemo/agent-db/runtime-store";
import { conversationRuntime } from "@mymemo/agent-db/schema";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

/** The two `conversation_runtime` pointers a Harness turn reads and writes. */
export interface HarnessRuntime {
	/** The Conversation's E2B Workspace (running or paused); `null` when none exists yet. */
	sandboxId: string | null;
	/**
	 * The opaque Harness resume pointer (ADR-0033): whatever `session.stop()`
	 * returned after the last turn, handed back verbatim as
	 * `createSession({ resumeFrom })`. chat-api never reads inside it — the
	 * Conversation's memory is the sandbox snapshot, not this value.
	 */
	harnessResumeState: HarnessAgentResumeSessionState | null;
}

export interface HarnessRuntimeStore {
	load(ref: ConversationRef): Promise<HarnessRuntime>;
	save(ref: ConversationRef, patch: Partial<HarnessRuntime>): Promise<void>;
}

/**
 * Stores both pointers on `conversation_runtime`. Unfenced on purpose: the AI
 * SDK chat path has no Run and no Conversation Ownership, so there is no epoch
 * to fence on; the `(user_id, conversation_id)` key is the only guard. The
 * Run path's fenced runtime-store helpers, taint, and orphan ledger stay Run-only.
 */
export class PostgresHarnessRuntimeStore implements HarnessRuntimeStore {
	constructor(private readonly db: Database) {}

	async load(ref: ConversationRef): Promise<HarnessRuntime> {
		const row = await loadConversationRuntimeTx(this.db, ref);
		return {
			sandboxId: row?.sandboxId ?? null,
			harnessResumeState:
				(row?.harnessResumeState as HarnessAgentResumeSessionState | null) ??
				null,
		};
	}

	async save(
		ref: ConversationRef,
		patch: Partial<HarnessRuntime>,
	): Promise<void> {
		await this.db
			.insert(conversationRuntime)
			.values({ ...ref, ...patch })
			.onConflictDoUpdate({
				target: [
					conversationRuntime.userId,
					conversationRuntime.conversationId,
				],
				set: { ...patch, updatedAt: new Date() },
			});
	}
}
