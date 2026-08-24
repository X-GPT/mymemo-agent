/** The versioned Chat API to AgentCore Runtime request boundary. */
export type AgentQueryRequest = {
	version: 1;
	conversationId: string;
	conversationEpoch: number;
	prompt: string;
	model: string;
	agentSessionId?: string;
};
