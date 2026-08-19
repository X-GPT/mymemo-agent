import {
	claimAgentCoreDispatchesTx,
	confirmAgentCoreDispatchPublishedTx,
} from "@mymemo/agent-db/agentcore-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import type { AgentCoreDispatchPublisherStore } from "./publisher";

export function createDatabaseAgentCoreDispatchPublisherStore(options: {
	db: Database;
	now?: () => Date;
}): AgentCoreDispatchPublisherStore {
	const now = options.now ?? (() => new Date());
	return {
		claim: async ({ publisherId, runId, limit }) =>
			await claimAgentCoreDispatchesTx(options.db, {
				publisherId,
				runId,
				limit,
				now: now(),
			}),
		confirm: async ({ runId, publisherId }) =>
			await confirmAgentCoreDispatchPublishedTx(options.db, {
				runId,
				publisherId,
				now: now(),
			}),
	};
}
