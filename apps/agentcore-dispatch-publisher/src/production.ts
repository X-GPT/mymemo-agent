import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import {
	loadOldestUnpublishedAgentCoreDispatchAdmittedAt,
	MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
} from "@mymemo/agent-db/agentcore-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import { createDatabaseAgentCoreDispatchPublisherStore } from "@mymemo/agentcore-dispatch/database-store";
import {
	type AgentCoreDispatchPublishResult,
	createAgentCoreDispatchPublisher,
} from "@mymemo/agentcore-dispatch/publisher";
import { createSqsAgentCoreDispatchQueue } from "@mymemo/agentcore-dispatch/sqs-queue";
import { createSsmAgentCoreDispatchEnablementControl } from "@mymemo/agentcore-dispatch/ssm-control";
import type { AgentCoreDispatchPublisherConfig } from "./config";
import type { PublisherLogger } from "./logger";
import type { AgentCoreDispatchPublisher } from "./publisher-loop";
import { recordPublisherPublication } from "./publisher-metrics";

interface DrainPendingOptions {
	signal: AbortSignal;
	loadOldestAdmittedAt(): Promise<Date | null>;
	publishBatch(): Promise<AgentCoreDispatchPublishResult>;
	recordPublication(
		result: AgentCoreDispatchPublishResult,
		pendingAgeMs: number,
	): void;
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
	const control = createSsmAgentCoreDispatchEnablementControl({
		client: new SSMClient({ region: options.config.awsRegion }),
		parameterName: options.config.enabledParameterName,
	});
	const publisher = createAgentCoreDispatchPublisher({
		publisherId: options.publisherId,
		control,
		store: createDatabaseAgentCoreDispatchPublisherStore({ db: options.db }),
		queue: createSqsAgentCoreDispatchQueue({
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
