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
import type { AdvisoryLockPool } from "../cleanup/advisory-lock";
import type { AgentCoreDispatchPublisherConfig } from "../config/env";
import type { WorkerLogger } from "../logger";
import { AgentCoreDispatchPublisherLoop } from "./publisher-loop";

/** Bind the worker's production authorities to the tested publisher loop. */
export function createProductionAgentCoreDispatchPublisherLoop(options: {
	db: Database;
	pool: AdvisoryLockPool;
	workerId: string;
	awsRegion: string;
	config: AgentCoreDispatchPublisherConfig;
	logger: WorkerLogger;
}): AgentCoreDispatchPublisherLoop {
	const control = createSsmCanaryEnablementControl({
		client: new SSMClient({ region: options.awsRegion }),
		parameterName: options.config.enabledParameterName,
	});
	const publisher = createCanaryDispatchPublisher({
		publisherId: `worker/${options.workerId}`,
		control,
		store: createDatabaseCanaryDispatchPublisherStore({ db: options.db }),
		queue: createSqsCanaryDispatchQueue({
			client: new SQSClient({ region: options.awsRegion }),
			queueUrl: options.config.queueUrl,
		}),
	});

	return new AgentCoreDispatchPublisherLoop({
		pool: options.pool,
		publisher,
		pendingStore: {
			oldestUnpublishedAdmittedAt: async () =>
				await loadOldestUnpublishedAgentCoreDispatchAdmittedAt(options.db),
		},
		intervalMs: options.config.intervalMs,
		logger: options.logger,
	});
}
