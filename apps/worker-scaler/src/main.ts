import { ECSClient } from "@aws-sdk/client-ecs";
import { createDatabase } from "@mymemo/agent-db/client";
import { readConversationQueueMetrics } from "@mymemo/agent-db/queue-metrics";
import { loadWorkerScalerConfigFromEnv } from "./config";
import { EcsUpdateServiceAdapter } from "./ecs-adapter";
import { EcsServiceStateStore } from "./ecs-state-store";
import { runWorkerScaler } from "./scaler";

const config = loadWorkerScalerConfigFromEnv(Bun.env);
const db = createDatabase(config.agentDatabaseUrl);
const ecsClient = new ECSClient({ region: config.awsRegion });
const target = {
	cluster: config.ecsCluster,
	service: config.ecsService,
};

const result = await runWorkerScaler({
	readMetrics: () => readConversationQueueMetrics(db),
	desiredCountAdapter: new EcsUpdateServiceAdapter(ecsClient, target),
	stateStore: new EcsServiceStateStore({
		client: ecsClient,
		...target,
	}),
	config: config.scaler,
});

console.log(JSON.stringify(result));
process.exit(0);
