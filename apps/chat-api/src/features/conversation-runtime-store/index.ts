// Persistent E2B workspace metadata (`conversation_runtime` / `orphan_sandboxes`)
// lives in the shared `@mymemo/agent-db` data layer: the fenced write protocol
// is exercised by BOTH chat-api and agent-worker (the worker's snapshot barrier
// writes checkpoints through these helpers, Task 5.3), so it has one definition
// over one `pg` driver — the same reason the run-store queue helpers are shared.
// chat-api keeps this `@/features/conversation-runtime-store` surface as a thin
// re-export so its imports stay stable.
export type {
	ConversationRuntimeRecord,
	OrphanSandboxRecord,
	RunOwnershipRef,
	WorkspaceCheckpointStatus,
} from "@mymemo/agent-db/runtime-store";
export {
	createConversationRuntimeTx,
	loadConversationRuntimeTx,
	markRuntimeCheckpointStatusTx,
	markRuntimeSandboxTaintedTx,
	recordOrphanSandboxTx,
	recordRuntimeSnapshotTx,
	updateRuntimeSandboxTx,
} from "@mymemo/agent-db/runtime-store";
