export type AgentQueryRuntimeInvoker = (request: {
	conversationId: string;
	model: "anthropic/claude-sonnet-5";
	prompt: string;
}) => Promise<Response>;

export function createHttpAgentQueryRuntimeInvoker(
	runtimeUrl: string,
): AgentQueryRuntimeInvoker {
	const invocationUrl = new URL("/invocations", runtimeUrl);

	return async (request) => {
		const response = await fetch(invocationUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/x-ndjson, application/json",
				"x-amzn-bedrock-agentcore-runtime-session-id": request.conversationId,
			},
			body: JSON.stringify({ model: request.model, prompt: request.prompt }),
		});
		const contentType = response.headers.get("content-type") ?? "";
		if (
			!response.body ||
			(response.ok
				? !contentType.startsWith("application/x-ndjson")
				: !contentType.startsWith("application/json"))
		) {
			await response.body?.cancel().catch(() => {});
			throw new Error("Agent-query Runtime returned an invalid response");
		}
		return response;
	};
}
