import { MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE } from "@mymemo/agent-db/canary-dispatch";

/** Deployment inputs shared with the dormant infrastructure slice (#452). */
export const CANARY_QUEUE_INVARIANTS = {
	queueType: "standard",
	queueEncrypted: true,
	deadLetterQueueEncrypted: true,
	publisherBatchSize: MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
	repairIntervalMinutes: 1,
	consumerBatchSize: 1,
	partialBatchResponses: true,
	consumerTimeoutSeconds: 120,
	visibilityTimeoutSeconds: 300,
	retentionSeconds: 24 * 60 * 60,
	maxReceiveCount: 3,
	reservedConsumerConcurrency: 1,
} as const;
