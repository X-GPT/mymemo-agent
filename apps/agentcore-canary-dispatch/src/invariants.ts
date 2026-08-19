import { MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE } from "@mymemo/agent-db/agentcore-dispatch";
import { AGENTCORE_UNOWNED_QUEUE_TIMEOUT_MS } from "@mymemo/agent-db/run-store";

/** Production deployment inputs shared with the AgentCore infrastructure. */
export const AGENTCORE_DISPATCH_QUEUE_INVARIANTS = {
	queueType: "standard",
	queueEncrypted: true,
	deadLetterQueueEncrypted: true,
	publisherBatchSize: MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
	consumerBatchSize: 1,
	partialBatchResponses: true,
	consumerTimeoutSeconds: 120,
	visibilityTimeoutSeconds: 180,
	queuedRunTimeoutSeconds: AGENTCORE_UNOWNED_QUEUE_TIMEOUT_MS / 1_000,
	retentionSeconds: 24 * 60 * 60,
	maxReceiveCount: 5,
	reservedConsumerConcurrency: null,
} as const;
