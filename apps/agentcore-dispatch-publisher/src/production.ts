import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { loadOldestUnpublishedAgentCoreDispatchAdmittedAt } from "@mymemo/agent-db/agentcore-dispatch";
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

/** Bind the process to its SSM, SQS, and Postgres adapters. */
export function createProductionAgentCoreDispatchPublisher(options: {
	db: Database;
	publisherId: string;
	config: AgentCoreDispatchPublisherConfig;
	logger: PublisherLogger;
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
			const oldest = await loadOldestUnpublishedAgentCoreDispatchAdmittedAt(
				options.db,
			);
			const pendingAgeMs = oldest
				? Math.max(0, Date.now() - oldest.getTime())
				: 0;
			const result = await publisher.publishPending();
			recordPublisherPublication(options.logger, result, pendingAgeMs);
		},
	};
}
