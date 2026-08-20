import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchPublishResult } from "@mymemo/agentcore-dispatch/publisher";
import {
	createAgentCoreConsumerHandler,
	createAgentCorePublisherHandler,
	createManualReplayHandler,
} from "./handlers";

const enabledPublication: AgentCoreDispatchPublishResult = {
	status: "enabled",
	publishedRunIds: ["run-450"],
	ambiguousRunIds: [],
};

describe("AgentCore dispatch Lambda handlers", () => {
	it("gives immediate and scheduled publication the same invocation-scoped behavior", async () => {
		const publishers: string[] = [];
		const handler = createAgentCorePublisherHandler({
			publish: async (publisherId) => {
				publishers.push(publisherId);
				return enabledPublication;
			},
		});

		await expect(
			handler({}, { awsRequestId: "lambda-request-1" }),
		).resolves.toEqual(enabledPublication);
		expect(publishers).toEqual(["lambda/lambda-request-1"]);
	});

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

	it("audits manual replay before invoking the shared publisher", async () => {
		const calls: string[] = [];
		const handler = createManualReplayHandler({
			replay: async (input) => {
				calls.push(`replay:${input.runId}:${input.requestedBy}`);
				return true;
			},
			publish: async (publisherId, runId) => {
				calls.push(`publish:${publisherId}:${runId}`);
				return enabledPublication;
			},
		});

		await expect(
			handler(
				{ runId: "run-450", requestedBy: "operator@example.com" },
				{ awsRequestId: "manual-request-1" },
			),
		).resolves.toEqual({
			replayed: true,
			deferred: false,
			publication: enabledPublication,
		});
		expect(calls).toEqual([
			"replay:run-450:operator@example.com",
			"publish:manual-replay/manual-request-1:run-450",
		]);
	});

	it("defers an eligible replay while the exact dispatch remains leased", async () => {
		const handler = createManualReplayHandler({
			replay: async () => true,
			publish: async () => ({
				...enabledPublication,
				publishedRunIds: [],
			}),
		});

		await expect(
			handler(
				{ runId: "run-450", requestedBy: "operator@example.com" },
				{ awsRequestId: "manual-request-1" },
			),
		).resolves.toEqual({
			replayed: false,
			deferred: true,
			publication: { ...enabledPublication, publishedRunIds: [] },
		});
	});

	it("rejects a replay request when the exact dispatch is no longer eligible", async () => {
		const handler = createManualReplayHandler({
			replay: async () => false,
			publish: async () => enabledPublication,
		});

		await expect(
			handler(
				{ runId: "run-450", requestedBy: "operator@example.com" },
				{ awsRequestId: "manual-request-1" },
			),
		).rejects.toThrow("AgentCore dispatch is not eligible for replay");
	});
});
