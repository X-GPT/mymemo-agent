import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";

/** Serialize only the strict, content-free production dispatch envelope. */
export function serializeAgentCoreDispatchEnvelope(
	dispatch: AgentCoreDispatchIdentity,
): string {
	return JSON.stringify({
		schemaVersion: dispatch.schemaVersion,
		userId: dispatch.userId,
		conversationId: dispatch.conversationId,
		runId: dispatch.runId,
		runtimeSessionId: dispatch.runtimeSessionId,
		admittedAt: dispatch.admittedAt.toISOString(),
	});
}
