export interface MymemoEvent {
	id?: string;
	message: EventMessage;
}

export type EventMessage =
	| ErrorEvent
	| TextDeltaEvent
	| TextCommitEvent
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

export interface DoneEvent {
	type: "done";
}

export interface CanceledEvent {
	type: "canceled";
}
