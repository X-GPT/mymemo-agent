/** The immutable runtime classification carried by every Conversation. */
export const CONVERSATION_EXECUTION_LANES = [
	"fargate",
	"agentcore_canary",
] as const;

export type ConversationExecutionLane =
	(typeof CONVERSATION_EXECUTION_LANES)[number];

export const FARGATE_EXECUTION_LANE = "fargate" as const;
export const AGENTCORE_CANARY_EXECUTION_LANE = "agentcore_canary" as const;

/** Fail closed when untrusted or manually written data reaches an app boundary. */
export function requireConversationExecutionLane(
	value: unknown,
): ConversationExecutionLane {
	if (
		typeof value === "string" &&
		(CONVERSATION_EXECUTION_LANES as readonly string[]).includes(value)
	) {
		return value as ConversationExecutionLane;
	}
	throw new Error(`Unknown Conversation execution lane: ${String(value)}`);
}
