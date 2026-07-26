// Persistent E2B workspace metadata (`conversation_runtime` / `orphan_sandboxes`)
// lives in the shared `@mymemo/agent-db` data layer: the fenced write protocol
// is exercised by BOTH chat-api and agent-worker. Sandbox/taint mutations use
// these helpers; run-store composes Agent-session pointer publication into the
// terminal transaction through the same shared fence.
// chat-api keeps this `@/features/conversation-runtime-store` compatibility
// surface over the runtime helpers and their user-bound mutation-owner type so
// its imports stay stable.

export type { UserRunMutationOwner } from "@mymemo/agent-db/run-ownership";
export type {
	ConversationRuntimeRecord,
	OrphanSandboxRecord,
} from "@mymemo/agent-db/runtime-store";
export {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
	markRuntimeSandboxTaintedTx,
	recordOrphanSandboxTx,
	updateRuntimeSandboxTx,
} from "@mymemo/agent-db/runtime-store";
