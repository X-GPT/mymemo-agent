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
	 * The launch claim: a claim token when this caller now owns a `launching`
	 * row (a fresh Conversation, a rehydrate from `terminated`, or a
	 * `launching` claim older than two minutes whose claimant went quiet);
	 * otherwise the row the Conversation already holds, which the caller must
	 * not launch for. The token fences the two writes below, so a launcher
	 * whose claim was re-claimed while it was still launching cannot record
	 * over, or release, the newer claimant.
	 */
	claimLaunch(ref: ConversationRef): Promise<string | ConversationVmRow>;
	/**
	 * Record the `RunMicrovm` result: `launching` → `running` in one write.
	 * False when the claim was superseded — the caller must retire its VM.
	 */
	recordLaunched(
		ref: ConversationRef,
		claimToken: string,
		vm: { microvmId: string; endpoint: string; imageVersion: string },
	): Promise<boolean>;
	/** A launch that failed: hand this claim back (`launching` → `terminated`). */
	releaseClaim(ref: ConversationRef, claimToken: string): Promise<void>;
	/**
	 * The VM is gone or being retired (8 h cap, failed boot, urgent upgrade):
	 * `running` → `terminated`, guarded on `microvmId` so a newer VM is never
	 * clobbered. The next `claimLaunch` re-claims the row for exactly one caller.
	 */
	markTerminated(
		ref: ConversationRef,
		options: { microvmId: string },
	): Promise<void>;
	/** The S3 key of the latest durable Checkpoint (#670); null before the first. */
	getCheckpointPointer(ref: ConversationRef): Promise<string | null>;
	/**
	 * Point the row at a new durable Checkpoint, guarded on the VM that wrote
	 * it: a VM the row no longer names (retired by an urgent upgrade while its
	 * suspend hook was still draining) must not fork the Conversation's
	 * lineage. Returns the previous key for deletion, or null when refused.
	 */
	swapCheckpointPointer(
		ref: ConversationRef,
		options: { microvmId: string; key: string },
	): Promise<{ previous: string | null } | null>;
}
