import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQueryRequest } from "@mymemo/agent-query";

/** One Runtime invocation. Implementations must not retry ambiguous failures. */
export interface AgentRuntimeInvoker {
	invoke(
		request: AgentQueryRequest,
	):
		| Promise<AsyncIterable<SDKMessage> | Iterable<SDKMessage>>
		| AsyncIterable<SDKMessage>
		| Iterable<SDKMessage>;
}
