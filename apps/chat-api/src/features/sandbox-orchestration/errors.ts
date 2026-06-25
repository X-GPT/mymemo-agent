export class SandboxCreationError extends Error {
	override name = "SandboxCreationError" as const;
}

export class ConversationBusyError extends Error {
	override name = "ConversationBusyError" as const;
}

/**
 * The turn tried to change a conversation's document scope. A conversation binds
 * one immutable scope for its lifetime (the daemon rejects a scope change with
 * 409), so unlike {@link ConversationBusyError} this is **not** retryable —
 * retrying the same turn can never succeed. Kept distinct so the client gets a
 * "start a new conversation" message instead of "try again shortly".
 */
export class ConversationScopeConflictError extends Error {
	override name = "ConversationScopeConflictError" as const;
}
