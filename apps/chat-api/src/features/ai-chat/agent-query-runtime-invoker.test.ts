import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import { createBedrockAgentQueryRuntimeInvoker } from "./agent-query-runtime-invoker";

it("invokes the Conversation-bound Runtime and parses split NDJSON chunks", async () => {
	const request: AgentQueryRequest = {
		version: 1,
		conversationId: "conversation-1",
		conversationEpoch: 7,
		prompt: "Continue",
		model: "anthropic/claude-sonnet-5",
		agentSessionId: "agent-session-1",
	};
	let commandInput: Record<string, unknown> | undefined;
	let destroyed = false;
	const response = Object.assign(
		(async function* () {
			yield new TextEncoder().encode('{"type":"stream_event"}\n{"type"');
			yield new TextEncoder().encode(
				':"result","session_id":"agent-session-2"}\n',
			);
		})(),
		{
			destroy: () => {
				destroyed = true;
			},
		},
	);
	const invoker = createBedrockAgentQueryRuntimeInvoker({
		agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123:runtime/direct",
		client: {
			async send(command) {
				commandInput = command.input as Record<string, unknown>;
				return { response };
			},
		},
	});

	const messages: unknown[] = [];
	for await (const message of await invoker.invoke(request))
		messages.push(message);

	expect(commandInput).toMatchObject({
		agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123:runtime/direct",
		runtimeSessionId: "conversation-1",
		contentType: "application/json",
		accept: "application/x-ndjson",
		qualifier: "DEFAULT",
	});
	expect(
		JSON.parse(new TextDecoder().decode(commandInput?.payload as Uint8Array)),
	).toEqual(request);
	expect(messages).toEqual([
		{ type: "stream_event" },
		{ type: "result", session_id: "agent-session-2" },
	]);
	expect(destroyed).toBe(true);
});

it("composes direct Agent queries only in the non-production local entrypoint", () => {
	const production = readFileSync(
		join(import.meta.dir, "../../index.ts"),
		"utf8",
	);
	const local = readFileSync(
		join(import.meta.dir, "../../../local/index.ts"),
		"utf8",
	);

	expect(production).not.toContain("createAiChatRoutes");
	expect(production).not.toContain("AGENT_QUERY_RUNTIME_ARN");
	expect(local).toContain("createAiChatRoutes");
	expect(local).toContain("AGENT_QUERY_RUNTIME_ARN");
});
