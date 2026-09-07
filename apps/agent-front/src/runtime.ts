import {
	BedrockAgentCoreClient,
	InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { Scope } from "./schema";

export interface Invocation {
	conversationId: string;
	turnId: string;
	seq: number;
	requestId: string;
	userId: string;
	scope: Scope;
	text: string;
	startedAt: number;
	budgetUntil: number;
	sandboxSessionId: string;
}
export type InvokeRuntime = (
	input: Invocation,
) => Promise<ReadableStream<Uint8Array>>;
export function agentCoreRuntime(arn: string): InvokeRuntime {
	const client = new BedrockAgentCoreClient({});
	return async (input) => {
		const result = await client.send(
			new InvokeAgentRuntimeCommand({
				agentRuntimeArn: arn,
				runtimeSessionId: input.turnId,
				contentType: "application/json",
				accept: "application/x-ndjson",
				payload: Buffer.from(JSON.stringify(input)),
			}),
		);
		if (!result.response) throw new Error("Runtime returned no stream");
		return result.response.transformToWebStream();
	};
}
export async function* sdkMessages(stream: ReadableStream<Uint8Array>) {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let pending = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			pending += value;
			let end = pending.indexOf("\n");
			while (end >= 0) {
				const line = pending.slice(0, end).trim();
				pending = pending.slice(end + 1);
				if (line) yield JSON.parse(line) as unknown;
				end = pending.indexOf("\n");
			}
		}
		if (pending.trim()) yield JSON.parse(pending) as unknown;
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}
