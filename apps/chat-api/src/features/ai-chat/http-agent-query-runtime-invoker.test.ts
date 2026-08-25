import { expect, it, spyOn } from "bun:test";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import { createHttpAgentQueryRuntimeInvoker } from "./http-agent-query-runtime-invoker";

it("invokes the Conversation-bound local Runtime and parses split NDJSON chunks", async () => {
	const request: AgentQueryRequest = {
		version: 1,
		conversationId: "conversation-1",
		conversationEpoch: 7,
		prompt: "Continue",
		model: "anthropic/claude-sonnet-5",
		agentSessionId: "agent-session-1",
	};
	let received:
		| { url: string; headers: Headers; body: AgentQueryRequest }
		| undefined;
	const encoder = new TextEncoder();
	const fetchImplementation = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		received = {
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as AgentQueryRequest,
		};
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode('{"type":"stream_event"}\n{"type"'),
					);
					controller.enqueue(
						encoder.encode(':"result","session_id":"agent-session-2"}\n'),
					);
					controller.close();
				},
			}),
			{ headers: { "content-type": "application/x-ndjson" } },
		);
	};
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		fetchImplementation as unknown as typeof fetch,
	);

	try {
		const invoker = createHttpAgentQueryRuntimeInvoker({
			runtimeUrl: "http://agent-query-runtime:4510",
		});
		const messages: unknown[] = [];
		for await (const message of await invoker.invoke(request)) {
			messages.push(message);
		}

		if (!received) throw new Error("expected local Runtime request");
		expect(received.url).toBe("http://agent-query-runtime:4510/invocations");
		expect(received.headers.get("content-type")).toBe("application/json");
		expect(received.headers.get("accept")).toBe("application/x-ndjson");
		expect(
			received.headers.get("x-amzn-bedrock-agentcore-runtime-session-id"),
		).toBe("conversation-1");
		expect(received.body).toEqual(request);
		expect(messages).toEqual([
			{ type: "stream_event" },
			{ type: "result", session_id: "agent-session-2" },
		]);
	} finally {
		fetchMock.mockRestore();
	}
});
