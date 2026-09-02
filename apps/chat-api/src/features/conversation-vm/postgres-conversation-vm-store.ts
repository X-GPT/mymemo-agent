import type { Database } from "@mymemo/agent-db/client";
import { conversationVm } from "@mymemo/agent-db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";
import type {
	ConversationVmRow,
	ConversationVmState,
	ConversationVmStore,
} from "./conversation-vm-store";

export class PostgresConversationVmStore implements ConversationVmStore {
	constructor(private readonly db: Database) {}

	async claimLaunch(ref: ConversationRef): Promise<string | ConversationVmRow> {
		const claimToken = crypto.randomUUID();
		// One statement is the whole claim. The insert wins a fresh Conversation;
		// on conflict the update re-claims only a `terminated` row (rehydrate) or
		// a `launching` one whose claimant went quiet (chat-api died mid-launch).
		// `ON CONFLICT DO UPDATE` locks the existing row, so concurrent claimants
		// serialize on it and the second sees the first's fresh `launching`
		// claim, which the WHERE refuses — exactly one row comes back.
		const claimed = await this.db
			.insert(conversationVm)
			.values({ ...ref, state: "launching", claimToken })
			.onConflictDoUpdate({
				target: [conversationVm.userId, conversationVm.conversationId],
				set: {
					state: "launching",
					claimToken,
					microvmId: null,
					endpoint: null,
					imageVersion: null,
					lastActivityAt: sql`now()`,
				},
				setWhere: sql`${conversationVm.state} = 'terminated' or (${conversationVm.state} = 'launching' and ${conversationVm.lastActivityAt} < now() - interval '2 minutes')`,
			})
			.returning({ userId: conversationVm.userId });
		if (claimed.length > 0) return claimToken;
		const [row] = await this.db
			.select({
				microvmId: conversationVm.microvmId,
				endpoint: conversationVm.endpoint,
				imageVersion: conversationVm.imageVersion,
				state: conversationVm.state,
			})
			.from(conversationVm)
			.where(this.owned(ref));
		if (!row) {
			// The row vanished between the two statements: a permanent deletion
			// cascaded it away, so there is no Conversation to serve.
			throw new Error("conversation_vm row disappeared during claim");
		}
		return { ...row, state: row.state as ConversationVmState };
	}

	async recordLaunched(
		ref: ConversationRef,
		claimToken: string,
		vm: { microvmId: string; endpoint: string; imageVersion: string },
	): Promise<boolean> {
		const recorded = await this.db
			.update(conversationVm)
			.set({
				...vm,
				state: "running",
				claimToken: null,
				lastActivityAt: sql`now()`,
			})
			.where(this.claimed(ref, claimToken))
			.returning({ userId: conversationVm.userId });
		return recorded.length > 0;
	}

	async releaseClaim(ref: ConversationRef, claimToken: string): Promise<void> {
		await this.db
			.update(conversationVm)
			.set({ state: "terminated", claimToken: null })
			.where(this.claimed(ref, claimToken));
	}

	async markTerminated(
		ref: ConversationRef,
		options: { microvmId: string },
	): Promise<void> {
		await this.db
			.update(conversationVm)
			.set({ state: "terminated" })
			.where(
				and(
					this.owned(ref),
					eq(conversationVm.state, "running"),
					eq(conversationVm.microvmId, options.microvmId),
				),
			);
	}

	/** This caller's own `launching` claim — the fence for record and release. */
	private claimed(ref: ConversationRef, claimToken: string) {
		return and(
			this.owned(ref),
			eq(conversationVm.state, "launching"),
			eq(conversationVm.claimToken, claimToken),
		);
	}

	private owned(ref: ConversationRef) {
		return and(
			eq(conversationVm.userId, ref.userId),
			eq(conversationVm.conversationId, ref.conversationId),
		);
	}
}
