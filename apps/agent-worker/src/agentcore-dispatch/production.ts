import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { loadOldestUnpublishedAgentCoreDispatchAdmittedAt } from "@mymemo/agent-db/canary-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import {
	createDatabaseCanaryDispatchPublisherStore,
	createSqsCanaryDispatchQueue,
	createSsmCanaryEnablementControl,
} from "agentcore-canary-dispatch/aws-adapters";
import { createCanaryDispatchPublisher } from "agentcore-canary-dispatch/publisher";
import type { AgentCoreDispatchPublisherConfig } from "../config/env";
import type {
	AgentCoreDispatchPendingStore,
	AgentCoreDispatchPublisher,
} from "./publisher-loop";

/** Bind the dedicated publisher process to its SSM, SQS, and database ports. */
export function createProductionAgentCoreDispatchPublisher(options: {
	db: Database;
	publisherId: string;
	config: AgentCoreDispatchPublisherConfig;
}): {
	publisher: AgentCoreDispatchPublisher;
	pendingStore: AgentCoreDispatchPendingStore;
} {
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
		publisher,
		pendingStore: {
			oldestUnpublishedAdmittedAt: async () =>
				await loadOldestUnpublishedAgentCoreDispatchAdmittedAt(options.db),
		},
	};
}
