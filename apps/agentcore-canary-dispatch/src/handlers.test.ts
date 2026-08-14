import { describe, expect, it } from "bun:test";
import {
	createCanaryConsumerHandler,
	createCanaryPublisherHandler,
	createManualReplayHandler,
} from "./handlers";
import type { CanaryPublishResult } from "./publisher";

const enabledPublication: CanaryPublishResult = {
	status: "enabled",
	overdueCampaignIds: [],
	publishedDispatchIds: ["dispatch-450"],
	ambiguousDispatchIds: [],
};

describe("Canary dispatch Lambda handlers", () => {
	it("gives immediate and scheduled publication the same invocation-scoped behavior", async () => {
		const publishers: string[] = [];
		const handler = createCanaryPublisherHandler({
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
		const handler = createCanaryConsumerHandler({
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
					{ messageId: "message-1", body: "first", eventSource: "aws:sqs" },
					{ messageId: "message-2", body: "second", eventSource: "aws:sqs" },
				],
			}),
		).resolves.toEqual({
			batchItemFailures: [{ itemIdentifier: "message-2" }],
		});
		expect(events).toEqual([
			{
				Records: [
					{ messageId: "message-1", body: "first" },
					{ messageId: "message-2", body: "second" },
				],
			},
		]);
	});

	it("audits manual replay before invoking the shared publisher", async () => {
		const calls: string[] = [];
		const handler = createManualReplayHandler({
			replay: async (input) => {
				calls.push(`replay:${input.dispatchId}:${input.requestedBy}`);
				return true;
			},
			publish: async (publisherId) => {
				calls.push(`publish:${publisherId}`);
				return enabledPublication;
			},
		});

		await expect(
			handler(
				{ dispatchId: "dispatch-450", requestedBy: "operator@example.com" },
				{ awsRequestId: "manual-request-1" },
			),
		).resolves.toEqual({
			replayed: true,
			deferred: false,
			publication: enabledPublication,
		});
		expect(calls).toEqual([
			"replay:dispatch-450:operator@example.com",
			"publish:manual-replay/manual-request-1",
		]);
	});

	it("defers an eligible replay while the exact dispatch remains leased", async () => {
		const handler = createManualReplayHandler({
			replay: async () => true,
			publish: async () => ({
				...enabledPublication,
				publishedDispatchIds: [],
			}),
		});

		await expect(
			handler(
				{ dispatchId: "dispatch-450", requestedBy: "operator@example.com" },
				{ awsRequestId: "manual-request-1" },
			),
		).resolves.toEqual({
			replayed: false,
			deferred: true,
			publication: { ...enabledPublication, publishedDispatchIds: [] },
		});
	});

	it("rejects a replay request when the exact dispatch is no longer eligible", async () => {
		const handler = createManualReplayHandler({
			replay: async () => false,
			publish: async () => enabledPublication,
		});

		await expect(
			handler(
				{ dispatchId: "dispatch-450", requestedBy: "operator@example.com" },
				{ awsRequestId: "manual-request-1" },
			),
		).rejects.toThrow("Canary dispatch is not eligible for replay");
	});
});
