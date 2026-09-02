import type { Database } from "@mymemo/agent-db/client";
import { conversationVm } from "@mymemo/agent-db/schema";
import { and, eq, sql } from "drizzle-orm";
import type {
	ConversationRef,
	ConversationVmRow,
	ConversationVmState,
	ConversationVmStore,
} from "./conversation-vm-store";

export class PostgresConversationVmStore implements ConversationVmStore {
	constructor(private readonly db: Database) {}

	async claimLaunch(
		ref: ConversationRef,
		options: { staleLaunchAfterMs: number },
	): Promise<"claimed" | ConversationVmRow> {
		// One statement is the whole claim. The insert wins a fresh Conversation;
		// on conflict the update re-claims only a `terminated` row (rehydrate) or
		// a `launching` one whose claimant went quiet (chat-api died mid-launch).
		// `ON CONFLICT DO UPDATE` locks the existing row, so concurrent claimants
		// serialize on it and the second sees the first's fresh `launching`
		// claim, which the WHERE refuses — exactly one row comes back.
		const claimed = await this.db
			.insert(conversationVm)
			.values({ ...ref, state: "launching" })
			.onConflictDoUpdate({
				target: [conversationVm.userId, conversationVm.conversationId],
				set: {
					state: "launching",
					microvmId: null,
					endpoint: null,
					imageVersion: null,
					lastActivityAt: sql`now()`,
				},
				setWhere: sql`${conversationVm.state} = 'terminated' or (${conversationVm.state} = 'launching' and ${conversationVm.lastActivityAt} < now() - make_interval(secs => ${options.staleLaunchAfterMs / 1000}))`,
			})
			.returning({ userId: conversationVm.userId });
		if (claimed.length > 0) return "claimed";
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

	async claimUpgrade(
		ref: ConversationRef,
		options: { microvmId: string },
	): Promise<boolean> {
		const won = await this.db
			.update(conversationVm)
			.set({
				state: "launching",
				microvmId: null,
				endpoint: null,
				imageVersion: null,
				lastActivityAt: sql`now()`,
			})
			.where(
				and(
					this.owned(ref),
					eq(conversationVm.state, "running"),
					eq(conversationVm.microvmId, options.microvmId),
				),
			)
			.returning({ userId: conversationVm.userId });
		return won.length > 0;
	}

	async recordLaunched(
		ref: ConversationRef,
		vm: { microvmId: string; endpoint: string; imageVersion: string },
	): Promise<void> {
		await this.db
			.update(conversationVm)
			.set({ ...vm, state: "running", lastActivityAt: sql`now()` })
			.where(and(this.owned(ref), eq(conversationVm.state, "launching")));
	}

	async releaseClaim(ref: ConversationRef): Promise<void> {
		await this.db
			.update(conversationVm)
			.set({ state: "terminated" })
			.where(and(this.owned(ref), eq(conversationVm.state, "launching")));
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

	async touchActivity(ref: ConversationRef): Promise<void> {
		await this.db
			.update(conversationVm)
			.set({ lastActivityAt: sql`now()` })
			.where(and(this.owned(ref), eq(conversationVm.state, "running")));
	}

	private owned(ref: ConversationRef) {
		return and(
			eq(conversationVm.userId, ref.userId),
			eq(conversationVm.conversationId, ref.conversationId),
		);
	}
}
