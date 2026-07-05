export interface MymemoEvent {
	id?: string;
	message: EventMessage;
}

export type EventMessage =
	| ErrorEvent
	| TextDeltaEvent
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

export interface TextDeltaEvent {
	type: "text_delta";
	text: string;
}

export interface DoneEvent {
	type: "done";
}

export interface CanceledEvent {
	type: "canceled";
}
