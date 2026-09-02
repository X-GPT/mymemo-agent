import type { ALL_VM_STATES } from "@mymemo/agent-db/schema";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

/**
 * The per-Conversation MicroVM registry and its transactional launch claim
 * (spec #654, ticket #669) over `conversation_vm`. Every write here is what
 * makes "one VM per Conversation" true under concurrent POSTs: the platform
 * cannot make `RunMicrovm` idempotent per Conversation, so the claim row is
 * the lock, and exactly one claimant launches.
 */

export type ConversationVmState = (typeof ALL_VM_STATES)[number];

export interface ConversationVmRow {
	/** NULL while `launching`. */
	microvmId: string | null;
	endpoint: string | null;
	imageVersion: string | null;
	state: ConversationVmState;
}

export interface ConversationVmStore {
	/**
	 * The launch claim: `"claimed"` when this caller now owns a `launching` row
	 * (a fresh Conversation, a rehydrate from `terminated`, or a `launching`
	 * claim older than two minutes whose claimant died mid-launch); otherwise
	 * the row the Conversation already holds, which the caller must not launch
	 * for.
	 */
	claimLaunch(ref: ConversationRef): Promise<"claimed" | ConversationVmRow>;
	/** Record the `RunMicrovm` result: `launching` → `running` in one write. */
	recordLaunched(
		ref: ConversationRef,
		vm: { microvmId: string; endpoint: string; imageVersion: string },
	): Promise<void>;
	/** A launch that failed: hand the claim back (`launching` → `terminated`). */
	releaseClaim(ref: ConversationRef): Promise<void>;
	/**
	 * The VM is gone or being retired (8 h cap, failed boot, urgent upgrade):
	 * `running` → `terminated`, guarded on `microvmId` so a newer VM is never
	 * clobbered. The next `claimLaunch` re-claims the row for exactly one caller.
	 */
	markTerminated(
		ref: ConversationRef,
		options: { microvmId: string },
	): Promise<void>;
}
