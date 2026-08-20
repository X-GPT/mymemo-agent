import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import {
	releaseConversationTx,
	renewConversationLeaseTx,
} from "@mymemo/agent-db/conversation-ownership";
import { loadExecutingRunTx } from "@mymemo/agent-db/run-store";
import { toMessage, type WorkerLogger } from "agent-worker/logger";
import type { RunServing } from "agent-worker/run-serving";
import type { CommittedAgentCoreAcquisition } from "agentcore-dispatch-consumer/acquisition-boundary";
import type { AgentCoreRuntimeDependencies } from "./runtime";

/** Bind exact AgentCore acquisition to the same already-running Run-serving
 * seam Fargate uses, without importing its Claim, drain, expiration, or
 * Reclamation loops. */
export function createAgentCoreExecutionServices(options: {
	db: Database;
	acquire(
		dispatch: AgentCoreDispatchIdentity,
	): Promise<CommittedAgentCoreAcquisition>;
	runServing: RunServing;
	logger: WorkerLogger;
}): Pick<
	AgentCoreRuntimeDependencies,
	"acquire" | "serve" | "heartbeat" | "release"
> {
	return {
		acquire: options.acquire,

		async serve(input) {
			const owner = {
				...input.acquisition.owner,
				runId: input.dispatch.runId,
				workerId: input.acquisition.workerId,
			};
			const run = await loadExecutingRunTx(options.db, owner);
			if (!run) {
				throw new Error("acquired AgentCore Run is no longer executable");
			}
			return await options.runServing.serveStartedRun({
				run,
				owner,
				shutdownSignal: input.shutdownSignal,
				onDetached: input.onDetached,
			});
		},

		async heartbeat(input) {
			if (!input.detached) {
				await options.runServing.heartbeat();
				return "alive";
			}
			try {
				const ownerUntil = await renewConversationLeaseTx(
					options.db,
					input.owner,
				);
				return ownerUntil ? "alive" : "lost";
			} catch (error) {
				options.logger.error({
					message: "AgentCore Ownership lease renewal failed",
					workerId: input.workerId,
					conversationId: input.owner.conversationId,
					error: toMessage(error),
				});
				return "alive";
			}
		},

		async release(input) {
			try {
				if (await releaseConversationTx(options.db, input.owner)) return;
				options.logger.warn({
					message: "AgentCore Ownership release matched no Conversation",
					workerId: input.workerId,
					conversationId: input.owner.conversationId,
					runId: input.runId,
				});
			} catch (error) {
				// The lease lapses and shared Fargate Reclamation remains the backstop.
				options.logger.error({
					message: "AgentCore Ownership release failed",
					workerId: input.workerId,
					conversationId: input.owner.conversationId,
					runId: input.runId,
					error: toMessage(error),
				});
			}
		},
	};
}
