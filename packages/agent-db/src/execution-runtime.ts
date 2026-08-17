/** The immutable runtime classification carried by every Conversation. */
export const CONVERSATION_EXECUTION_RUNTIMES = [
	"fargate",
	"agentcore",
] as const;

export type ConversationExecutionRuntime =
	(typeof CONVERSATION_EXECUTION_RUNTIMES)[number];

export const FARGATE_EXECUTION_RUNTIME = "fargate" as const;
export const AGENTCORE_EXECUTION_RUNTIME = "agentcore" as const;

/** Fail closed when untrusted or manually written data reaches an app boundary. */
export function requireConversationExecutionRuntime(
	value: unknown,
): ConversationExecutionRuntime {
	if (
		typeof value === "string" &&
		(CONVERSATION_EXECUTION_RUNTIMES as readonly string[]).includes(value)
	) {
		return value as ConversationExecutionRuntime;
	}
	throw new Error(`Unknown Conversation execution runtime: ${String(value)}`);
}
