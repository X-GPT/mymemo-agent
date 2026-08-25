import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQueryRequest } from "@mymemo/agent-query";

async function* parseNdjson(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<SDKMessage> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffered += decoder.decode(chunk.value, { stream: true });
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				if (line.length > 0) yield JSON.parse(line) as SDKMessage;
			}
		}
		buffered += decoder.decode();
		if (buffered.length > 0) {
			throw new Error("Agent-query Runtime returned truncated NDJSON");
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

export function createHttpAgentQueryRuntimeInvoker(options: {
	runtimeUrl: string;
}) {
	const invocationUrl = new URL("/invocations", options.runtimeUrl);
	if (!["http:", "https:"].includes(invocationUrl.protocol)) {
		throw new Error("Agent-query Runtime URL must use HTTP or HTTPS");
	}

	return {
		async invoke(
			request: AgentQueryRequest,
		): Promise<AsyncIterable<SDKMessage>> {
			const response = await fetch(invocationUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/x-ndjson",
					"x-amzn-bedrock-agentcore-runtime-session-id": request.conversationId,
				},
				body: JSON.stringify(request),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error("Agent-query Runtime invocation failed");
			}
			if (
				!response.headers
					.get("content-type")
					?.startsWith("application/x-ndjson") ||
				!response.body
			) {
				await response.body?.cancel().catch(() => {});
				throw new Error("Agent-query Runtime returned no NDJSON stream");
			}
			return parseNdjson(response.body);
		},
	};
}
