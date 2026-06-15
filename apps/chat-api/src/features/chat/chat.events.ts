export interface MymemoEvent {
	id: string;
	message: EventMessage;
}

export type EventMessage =
	| ErrorEvent
	| TextDeltaEvent
	| DoneEvent
	| ConversationIdEvent
	| RunIdEvent
	| AgentSessionIdEvent
	| SandboxIdEvent;

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

// Claude SDK resume state surfaced by the daemon. Internal continuity token,
// distinct from the product-visible `conversation_id`.
export interface AgentSessionIdEvent {
	type: "agent_session_id";
	agentSessionId: string;
}

export interface SandboxIdEvent {
	type: "sandbox_id";
	sandboxId: string;
}

export interface TextDeltaEvent {
	type: "text_delta";
	text: string;
}

export interface DoneEvent {
	type: "done";
}
