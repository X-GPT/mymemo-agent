import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { AgentQueryRequest } from "@mymemo/agent-query";

function asByteStream(value: unknown): AsyncIterable<Uint8Array> {
	if (
		typeof value !== "object" ||
		value === null ||
		!(Symbol.asyncIterator in value)
	) {
		throw new Error("AgentCore Runtime returned no streaming response");
	}
	return value as AsyncIterable<Uint8Array>;
}

async function* parseNdjson(response: unknown): AsyncIterable<SDKMessage> {
	const chunks = asByteStream(response);
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		for await (const chunk of chunks) {
			buffered += decoder.decode(chunk, { stream: true });
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
			throw new Error("AgentCore Runtime returned truncated NDJSON");
		}
	} finally {
		const closable = response as {
			destroy?: () => void;
			cancel?: () => void | Promise<void>;
		};
		if (typeof closable.destroy === "function") closable.destroy();
		else if (typeof closable.cancel === "function") await closable.cancel();
	}
}

export function createBedrockAgentQueryRuntimeInvoker(options: {
	client: {
		send(command: InvokeAgentRuntimeCommand): Promise<{ response?: unknown }>;
	};
	agentRuntimeArn: string;
}) {
	return {
		async invoke(
			request: AgentQueryRequest,
		): Promise<AsyncIterable<SDKMessage>> {
			const result = await options.client.send(
				new InvokeAgentRuntimeCommand({
					agentRuntimeArn: options.agentRuntimeArn,
					runtimeSessionId: request.conversationId,
					payload: new TextEncoder().encode(JSON.stringify(request)),
					contentType: "application/json",
					accept: "application/x-ndjson",
					qualifier: "DEFAULT",
				}),
			);
			return parseNdjson(result.response);
		},
	};
}
