import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";
import { createSqsAgentCoreDispatchQueue } from "./sqs-queue";

const dispatch: AgentCoreDispatchIdentity = {
	schemaVersion: 2,
	userId: "service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	admittedAt: new Date("2026-08-14T16:00:00.000Z"),
};

describe("SQS AgentCore dispatch queue", () => {
	it("sends the strict content-free envelope to the configured queue", async () => {
		let body: string | undefined;
		const queue = createSqsAgentCoreDispatchQueue({
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/dispatch",
			client: {
				send: async (command) => {
					expect(command.input.QueueUrl).toBe(
						"https://sqs.us-west-2.amazonaws.com/123/dispatch",
					);
					body = command.input.MessageBody;
					return { MessageId: "sqs-message-1" };
				},
			},
		});

		await queue.send(dispatch);

		expect(JSON.parse(body ?? "")).toEqual({
			schemaVersion: 2,
			userId: dispatch.userId,
			conversationId: dispatch.conversationId,
			runId: dispatch.runId,
			runtimeSessionId: dispatch.runtimeSessionId,
			admittedAt: "2026-08-14T16:00:00.000Z",
		});
	});
});
