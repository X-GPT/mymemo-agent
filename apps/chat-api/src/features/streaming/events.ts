export interface MymemoEvent {
	id?: string;
	message: EventMessage;
}

export type EventMessage =
	| ErrorEvent
	| TextDeltaEvent
	| TextCommitEvent
	| ToolCallStartEvent
	| ToolCallArgsEvent
	| ToolCallEndEvent
	| ToolCallResultEvent
	| CustomEvent
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

export interface CustomEvent {
	type: "CUSTOM";
	name: string;
	value: unknown;
}

export interface ToolCallStartEvent {
	type: "TOOL_CALL_START";
	toolCallId: string;
	toolCallName: string;
	parentMessageId: string;
}

export interface ToolCallArgsEvent {
	type: "TOOL_CALL_ARGS";
	toolCallId: string;
	delta: string;
}

export interface ToolCallEndEvent {
	type: "TOOL_CALL_END";
	toolCallId: string;
}

export interface ToolCallResultEvent {
	type: "TOOL_CALL_RESULT";
	messageId: string;
	toolCallId: string;
	content: string;
	role: "tool";
}

export interface DoneEvent {
	type: "done";
}

export interface CanceledEvent {
	type: "canceled";
}
