import { expect, it, spyOn } from "bun:test";
import {
	type AgentQueryRuntimeInvoker,
	createHttpAgentQueryRuntimeInvoker,
} from "./http-agent-query-runtime-invoker";

type AgentQueryRequest = Parameters<AgentQueryRuntimeInvoker>[0];

it("invokes the Conversation-bound local Runtime and preserves its response", async () => {
	const request: AgentQueryRequest = {
		conversationId: "conversation-1",
		model: "anthropic/claude-sonnet-5",
		prompt: "hello",
	};
	const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response('{"type":"result"}\n', {
			headers: { "content-type": "application/x-ndjson" },
		}),
	);

	try {
		const response = await createHttpAgentQueryRuntimeInvoker(
			"http://agent-query-runtime:4510",
		)(request);
		expect(fetchMock).toHaveBeenCalledWith(
			new URL("http://agent-query-runtime:4510/invocations"),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/x-ndjson, application/json",
					"x-amzn-bedrock-agentcore-runtime-session-id": "conversation-1",
				},
				body: JSON.stringify({
					model: "anthropic/claude-sonnet-5",
					prompt: "hello",
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"type":"result"}\n');
	} finally {
		fetchMock.mockRestore();
	}
});

it("rejects a Runtime response outside the stream-or-error contract", async () => {
	const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ outcome: "done" }),
	);
	try {
		await expect(
			createHttpAgentQueryRuntimeInvoker("http://agent-query-runtime:4510")({
				conversationId: "conversation-1",
				model: "anthropic/claude-sonnet-5",
				prompt: "hello",
			}),
		).rejects.toThrow("Agent-query Runtime returned an invalid response");
	} finally {
		fetchMock.mockRestore();
	}
});
