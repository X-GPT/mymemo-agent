import { describe, expect, it } from "bun:test";
import type { CanaryDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import {
	createBedrockAgentCoreRuntimeInvoker,
	createSqsCanaryDispatchQueue,
	createSsmCanaryEnablementControl,
} from "./aws-adapters";

const dispatch: CanaryDispatchIdentity = {
	schemaVersion: 1,
	dispatchId: "dispatch-450",
	campaignId: "campaign-450",
	scenarioId: "baseline-v1",
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	expectedExecutionLane: "agentcore_canary",
	admittedAt: new Date("2026-08-14T16:00:00.000Z"),
};

describe("SSM Canary enablement control", () => {
	it("enables dispatch only for the exact deployment-owned enabled value", async () => {
		const values = ["enabled", "true", "ENABLED", undefined];
		const observed: boolean[] = [];
		for (const value of values) {
			const control = createSsmCanaryEnablementControl({
				parameterName: "/mymemo/agentcore-canary/enabled",
				client: {
					send: async (command) => {
						expect(command.input).toEqual({
							Name: "/mymemo/agentcore-canary/enabled",
							WithDecryption: false,
						});
						return { Parameter: { Value: value } };
					},
				},
			});
			observed.push(await control.isEnabled());
		}

		expect(observed).toEqual([true, false, false, false]);
	});
});

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
			agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123:runtime/canary",
			client: {
				send: async (command) => {
					expect(command.input).toMatchObject({
						agentRuntimeArn:
							"arn:aws:bedrock-agentcore:us-west-2:123:runtime/canary",
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
						dispatchId: dispatch.dispatchId,
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
			agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123:runtime/canary",
			client: { send: async () => ({ response }) },
		});

		const invocation = await invoker.invoke(dispatch);
		await invocation.close();
		expect(cancelled).toBe(true);
	});
});

describe("SQS Canary dispatch queue", () => {
	it("sends the strict content-free envelope to the configured standard queue", async () => {
		let body: string | undefined;
		const queue = createSqsCanaryDispatchQueue({
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/canary",
			client: {
				send: async (command) => {
					expect(command.input.QueueUrl).toBe(
						"https://sqs.us-west-2.amazonaws.com/123/canary",
					);
					body = command.input.MessageBody;
					return { MessageId: "sqs-message-1" };
				},
			},
		});

		await queue.send(dispatch);

		expect(JSON.parse(body ?? "")).toEqual({
			schemaVersion: 1,
			dispatchId: dispatch.dispatchId,
			campaignId: dispatch.campaignId,
			scenarioId: dispatch.scenarioId,
			userId: dispatch.userId,
			conversationId: dispatch.conversationId,
			runId: dispatch.runId,
			runtimeSessionId: dispatch.runtimeSessionId,
			expectedExecutionLane: "agentcore_canary",
			admittedAt: "2026-08-14T16:00:00.000Z",
		});
	});
});
