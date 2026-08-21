import { describe, expect, it } from "bun:test";
import { createAgentCoreConsumerHandler } from "./handlers";

describe("AgentCore dispatch Lambda handlers", () => {
	it("projects the AWS SQS event to the partial-batch consumer contract", async () => {
		const events: unknown[] = [];
		const handler = createAgentCoreConsumerHandler({
			handle: async (event) => {
				events.push(event);
				return {
					batchItemFailures: [{ itemIdentifier: "message-2" }],
				};
			},
		});

		await expect(
			handler({
				Records: [
					{ messageId: "message-2", body: "second", eventSource: "aws:sqs" },
				],
			}),
		).resolves.toEqual({
			batchItemFailures: [{ itemIdentifier: "message-2" }],
		});
		expect(events).toEqual([
			{
				Records: [{ messageId: "message-2", body: "second" }],
			},
		]);
	});

	it("rejects an SQS batch larger than the configured one-record boundary", async () => {
		const handler = createAgentCoreConsumerHandler({
			handle: async () => ({ batchItemFailures: [] }),
		});

		await expect(
			handler({
				Records: [
					{ messageId: "message-1", body: "first" },
					{ messageId: "message-2", body: "second" },
				],
			}),
		).rejects.toThrow("invalid AgentCore SQS event");
	});
});
