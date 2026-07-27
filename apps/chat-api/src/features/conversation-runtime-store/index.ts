// Persistent E2B workspace metadata (`conversation_runtime` / `orphan_sandboxes`)
// lives in the shared `@mymemo/agent-db` data layer: the fenced write protocol
// is exercised by BOTH chat-api and agent-worker. Sandbox/taint mutations use
// these helpers; run-store composes Agent-session pointer publication into the
// terminal transaction through the same shared fence.
// No source currently imports this pre-existing compatibility barrel; it is
// retained here without expanding its surface.
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
