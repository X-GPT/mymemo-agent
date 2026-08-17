import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import {
	loadOldestUnpublishedAgentCoreDispatchAdmittedAt,
	MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
} from "@mymemo/agent-db/agentcore-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import {
	createDatabaseCanaryDispatchPublisherStore,
	createSqsCanaryDispatchQueue,
	createSsmCanaryEnablementControl,
} from "agentcore-canary-dispatch/aws-adapters";
import { createCanaryDispatchPublisher } from "agentcore-canary-dispatch/publisher";
import type { AgentCoreDispatchPublisherConfig } from "./config";
import type { PublisherLogger } from "./logger";
import type { AgentCoreDispatchPublisher } from "./publisher-loop";
import { recordPublisherPublication } from "./publisher-metrics";

interface PublishBatchResult {
	status: "enabled" | "disabled";
	publishedRunIds: readonly string[];
	ambiguousRunIds: readonly string[];
}

interface DrainPendingOptions {
	signal: AbortSignal;
	loadOldestAdmittedAt(): Promise<Date | null>;
	publishBatch(): Promise<PublishBatchResult>;
	recordPublication(result: PublishBatchResult, pendingAgeMs: number): void;
}

/** Drain bounded batches without extending a tick after shutdown or uncertainty. */
export async function drainPendingAgentCoreDispatches(
	options: DrainPendingOptions,
): Promise<void> {
	while (!options.signal.aborted) {
		const oldest = await options.loadOldestAdmittedAt();
		const pendingAgeMs = oldest
			? Math.max(0, Date.now() - oldest.getTime())
			: 0;
		const result = await options.publishBatch();
		options.recordPublication(result, pendingAgeMs);

		if (
			result.status === "disabled" ||
			result.ambiguousRunIds.length > 0 ||
			result.publishedRunIds.length < MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE
		) {
			return;
		}
	}
}

/** Bind the process to its SSM, SQS, and Postgres adapters. */
export function createProductionAgentCoreDispatchPublisher(options: {
	db: Database;
	publisherId: string;
	config: AgentCoreDispatchPublisherConfig;
	logger: PublisherLogger;
	signal: AbortSignal;
}): AgentCoreDispatchPublisher {
	const control = createSsmCanaryEnablementControl({
		client: new SSMClient({ region: options.config.awsRegion }),
		parameterName: options.config.enabledParameterName,
	});
	const publisher = createCanaryDispatchPublisher({
		publisherId: options.publisherId,
		control,
		store: createDatabaseCanaryDispatchPublisherStore({ db: options.db }),
		queue: createSqsCanaryDispatchQueue({
			client: new SQSClient({ region: options.config.awsRegion }),
			queueUrl: options.config.queueUrl,
		}),
	});

	return {
		async publishPending(): Promise<void> {
			await drainPendingAgentCoreDispatches({
				signal: options.signal,
				loadOldestAdmittedAt: () =>
					loadOldestUnpublishedAgentCoreDispatchAdmittedAt(options.db),
				publishBatch: () => publisher.publishPending(),
				recordPublication: (result, pendingAgeMs) =>
					recordPublisherPublication(options.logger, result, pendingAgeMs),
			});
		},
	};
}
