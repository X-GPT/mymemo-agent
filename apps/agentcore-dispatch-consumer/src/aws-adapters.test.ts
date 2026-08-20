import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";
import { createBedrockAgentCoreRuntimeInvoker } from "./aws-adapters";

const dispatch: AgentCoreDispatchIdentity = {
	schemaVersion: 2,
	userId: "agentcore-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	admittedAt: new Date("2026-08-14T16:00:00.000Z"),
};

describe("AgentCore Runtime invoker", () => {
	it("binds the exact Conversation Runtime session and exposes a closable receipt stream", async () => {
		let destroyed = false;
		async function* responseChunks() {
			yield new TextEncoder().encode("receipt\n");
		}
		const response = Object.assign(responseChunks(), {
			destroy: () => {
				destroyed = true;
			},
		});
		const invoker = createBedrockAgentCoreRuntimeInvoker({
			agentRuntimeArn:
				"arn:aws:bedrock-agentcore:us-west-2:123:runtime/agentcore",
			client: {
				send: async (command) => {
					expect(command.input).toMatchObject({
						agentRuntimeArn:
							"arn:aws:bedrock-agentcore:us-west-2:123:runtime/agentcore",
						runtimeSessionId: dispatch.conversationId,
						contentType: "application/json",
						accept: "application/x-ndjson",
						qualifier: "DEFAULT",
					});
					expect(
						JSON.parse(
							new TextDecoder().decode(command.input.payload as Uint8Array),
						),
					).toMatchObject({
						runId: dispatch.runId,
					});
					return { response };
				},
			},
		});

		const invocation = await invoker.invoke(dispatch);
		expect(invocation.chunks).toBe(response);
		await invocation.close();
		expect(destroyed).toBe(true);
	});

	it("cancels a receipt stream when no synchronous destroy method exists", async () => {
		let cancelled = false;
		async function* responseChunks() {
			yield new TextEncoder().encode("receipt\n");
		}
		const response = Object.assign(responseChunks(), {
			cancel: async () => {
				cancelled = true;
			},
		});
		const invoker = createBedrockAgentCoreRuntimeInvoker({
			agentRuntimeArn:
				"arn:aws:bedrock-agentcore:us-west-2:123:runtime/agentcore",
			client: { send: async () => ({ response }) },
		});

		const invocation = await invoker.invoke(dispatch);
		await invocation.close();
		expect(cancelled).toBe(true);
	});
});
