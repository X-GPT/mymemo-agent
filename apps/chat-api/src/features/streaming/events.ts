import type { PublicToolName } from "@mymemo/agent-db/run-events";

export interface MymemoEvent {
	id?: string;
	message: EventMessage;
}

export type EventMessage =
	| ErrorEvent
	| TextDeltaEvent
	| TextCommitEvent
	| ToolUseEvent
	| ToolResultEvent
	| DoneEvent
	| CanceledEvent
	| ConversationIdEvent
	| RunIdEvent;

export interface ErrorEvent {
	type: "error";
	message: string;
}

export interface ConversationIdEvent {
	type: "conversation_id";
	conversationId: string;
}

export interface RunIdEvent {
	type: "run_id";
	runId: string;
}

export interface TextCommitEvent {
	type: "text_commit";
	messageId: string;
	text: string;
}

export interface TextDeltaEvent {
	type: "text_delta";
	messageId: string;
	deltaIndex: number;
	text: string;
}

/** One Tool invocation (ADR-0009): the short public tool name and the bounded,
 * client-safe projection of its arguments. Append-only and self-describing —
 * no correlation id; the matching result is a separate chronological item. */
export interface ToolUseEvent {
	type: "tool_use";
	tool: PublicToolName;
	arguments: Record<string, unknown>;
	truncated: boolean;
}

/** One Tool result (ADR-0009). An `isError` result carries the fixed safe
 * message; a run may terminate after an invocation with no result. */
export interface ToolResultEvent {
	type: "tool_result";
	tool: PublicToolName;
	result: Record<string, unknown>;
	isError: boolean;
	truncated: boolean;
}

export interface DoneEvent {
	type: "done";
}

export interface CanceledEvent {
	type: "canceled";
}
