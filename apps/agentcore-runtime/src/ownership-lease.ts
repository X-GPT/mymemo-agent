import type { Database } from "@mymemo/agent-db/client";
import {
	type ConversationOwner,
	renewConversationLeaseTx,
} from "@mymemo/agent-db/conversation-ownership";
import { toMessage, type WorkerLogger } from "./logger";

export type OwnershipLeaseRenewal =
	| { type: "renewed" }
	| { type: "lost" }
	| { type: "retry" };

/** Perform the shared lease-renewal query and bounded error handling. Callers
 * retain the layer-specific meaning of a lost lease. */
export async function renewOwnershipLease(input: {
	db: Database;
	owner: ConversationOwner;
	workerId: string;
	logger: WorkerLogger;
}): Promise<OwnershipLeaseRenewal> {
	let ownerUntil: Date | null;
	try {
		ownerUntil = await renewConversationLeaseTx(input.db, input.owner);
	} catch (error) {
		input.logger.error({
			message: "ownership lease renewal failed",
			workerId: input.workerId,
			conversationId: input.owner.conversationId,
			error: toMessage(error),
		});
		return { type: "retry" };
	}
	return ownerUntil ? { type: "renewed" } : { type: "lost" };
}
