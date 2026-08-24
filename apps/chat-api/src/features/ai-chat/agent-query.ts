/** The versioned Chat API to AgentCore Runtime request boundary. */
export interface AgentQueryRequest {
	version: 1;
	conversationId: string;
	conversationEpoch: number;
	prompt: string;
	model: string;
	agentSessionId?: string;
}

/** Native Claude streaming events used by the initial text-only projection. */
export type ClaudeStreamEvent =
	| {
			type: "message_start";
			message: { id: string; content: unknown[] };
	  }
	| {
			type: "content_block_start";
			index: number;
			content_block: { type: string; text?: string; [key: string]: unknown };
	  }
	| {
			type: "content_block_delta";
			index: number;
			delta: { type: string; text?: string };
	  }
	| { type: "content_block_stop"; index: number }
	| { type: "message_stop" };

/** Controlled native Claude Agent SDK messages emitted by Runtime. */
export type ClaudeAgentEvent =
	| {
			type: "stream_event";
			event: ClaudeStreamEvent;
			parent_tool_use_id: string | null;
			uuid: string;
			session_id: string;
	  }
	| {
			type: "result";
			subtype: string;
			is_error: boolean;
			result?: string;
			errors?: string[];
			session_id?: string;
	  };

/** One Runtime invocation. Implementations must not retry ambiguous failures. */
export interface AgentRuntimeInvoker {
	invoke(
		request: AgentQueryRequest,
	):
		| Promise<AsyncIterable<unknown> | Iterable<unknown>>
		| AsyncIterable<unknown>
		| Iterable<unknown>;
}
