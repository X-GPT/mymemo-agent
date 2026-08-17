import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { AgentCoreRuntimeInvoker } from "./consumer";
import { serializeCanaryDispatchEnvelope } from "./contract";

interface AgentCoreCommandClient {
	send(command: InvokeAgentRuntimeCommand): Promise<{ response?: unknown }>;
}

function asReceiptStream(value: unknown): AsyncIterable<Uint8Array> {
	if (
		typeof value !== "object" ||
		value === null ||
		!(Symbol.asyncIterator in value)
	) {
		throw new Error("AgentCore Runtime returned no streaming response");
	}
	return value as AsyncIterable<Uint8Array>;
}

export function createBedrockAgentCoreRuntimeInvoker(options: {
	client: AgentCoreCommandClient;
	agentRuntimeArn: string;
}): AgentCoreRuntimeInvoker {
	return {
		async invoke(dispatch) {
			const result = await options.client.send(
				new InvokeAgentRuntimeCommand({
					agentRuntimeArn: options.agentRuntimeArn,
					runtimeSessionId: dispatch.runtimeSessionId,
					payload: new TextEncoder().encode(
						serializeCanaryDispatchEnvelope(dispatch),
					),
					contentType: "application/json",
					accept: "application/x-ndjson",
					qualifier: "DEFAULT",
				}),
			);
			const response = result.response;
			const chunks = asReceiptStream(response);
			return {
				chunks,
				async close() {
					if (typeof response !== "object" || response === null) return;
					const closable = response as {
						destroy?: () => void;
						cancel?: () => void | Promise<void>;
					};
					if (typeof closable.destroy === "function") {
						closable.destroy();
						return;
					}
					if (typeof closable.cancel === "function") {
						await closable.cancel();
					}
				},
			};
		},
	};
}
