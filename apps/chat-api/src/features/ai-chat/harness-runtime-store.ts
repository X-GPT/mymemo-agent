import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
import type { Database } from "@mymemo/agent-db/client";
import { conversationRuntime } from "@mymemo/agent-db/schema";
import { and, eq } from "drizzle-orm";
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
	resumeState: HarnessAgentResumeSessionState | null;
}

export interface HarnessRuntimeStore {
	load(ref: ConversationRef): Promise<HarnessRuntime>;
	saveResumeState(
		ref: ConversationRef,
		state: HarnessAgentResumeSessionState,
	): Promise<void>;
	saveSandboxId(ref: ConversationRef, sandboxId: string): Promise<void>;
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
		const [row] = await this.db
			.select({
				sandboxId: conversationRuntime.sandboxId,
				resumeState: conversationRuntime.harnessResumeState,
			})
			.from(conversationRuntime)
			.where(
				and(
					eq(conversationRuntime.userId, ref.userId),
					eq(conversationRuntime.conversationId, ref.conversationId),
				),
			);
		return {
			sandboxId: row?.sandboxId ?? null,
			resumeState:
				(row?.resumeState as HarnessAgentResumeSessionState | undefined) ??
				null,
		};
	}

	saveResumeState(
		ref: ConversationRef,
		state: HarnessAgentResumeSessionState,
	): Promise<void> {
		return this.upsert(ref, { harnessResumeState: state });
	}

	saveSandboxId(ref: ConversationRef, sandboxId: string): Promise<void> {
		return this.upsert(ref, { sandboxId });
	}

	private async upsert(
		ref: ConversationRef,
		values: Partial<typeof conversationRuntime.$inferInsert>,
	): Promise<void> {
		await this.db
			.insert(conversationRuntime)
			.values({ ...ref, ...values })
			.onConflictDoUpdate({
				target: [
					conversationRuntime.userId,
					conversationRuntime.conversationId,
				],
				set: { ...values, updatedAt: new Date() },
			});
	}
}
