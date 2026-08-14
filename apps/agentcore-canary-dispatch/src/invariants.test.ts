import { describe, expect, it } from "bun:test";
import { MAX_CANARY_DISPATCH_PUBLISH_BATCH_SIZE } from "@mymemo/agent-db/canary-dispatch";
import { CANARY_QUEUE_INVARIANTS } from "./invariants";

describe("production Canary queue invariants", () => {
	it("pins the agreed standard queue, retry, encryption, and concurrency boundary", () => {
		expect(CANARY_QUEUE_INVARIANTS).toEqual({
			queueType: "standard",
			queueEncrypted: true,
			deadLetterQueueEncrypted: true,
			publisherBatchSize: 10,
			repairIntervalMinutes: 1,
			consumerBatchSize: 1,
			partialBatchResponses: true,
			consumerTimeoutSeconds: 120,
			visibilityTimeoutSeconds: 300,
			retentionSeconds: 86_400,
			maxReceiveCount: 3,
			reservedConsumerConcurrency: 1,
		});
		expect(CANARY_QUEUE_INVARIANTS.visibilityTimeoutSeconds).toBeGreaterThan(
			CANARY_QUEUE_INVARIANTS.consumerTimeoutSeconds,
		);
		expect(CANARY_QUEUE_INVARIANTS.publisherBatchSize).toBe(
			MAX_CANARY_DISPATCH_PUBLISH_BATCH_SIZE,
		);
	});
});
