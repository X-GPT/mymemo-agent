/** The versioned Chat API to AgentCore Runtime request boundary. */
export interface AgentQueryRequest {
	version: 1;
	conversationId: string;
	conversationEpoch: number;
	prompt: string;
	model: string;
	agentSessionId?: string;
}
