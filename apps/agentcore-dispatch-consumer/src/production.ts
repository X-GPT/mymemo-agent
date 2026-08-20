import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import {
	loadAgentCoreDispatchRunStatus,
	requestAgentCoreDispatchReplayTx,
} from "@mymemo/agent-db/agentcore-dispatch";
import { createDatabase } from "@mymemo/agent-db/client";
import { createDatabaseAgentCoreDispatchPublisherStore } from "@mymemo/agentcore-dispatch/database-store";
import { createAgentCoreDispatchPublisher } from "@mymemo/agentcore-dispatch/publisher";
import { createSqsAgentCoreDispatchQueue } from "@mymemo/agentcore-dispatch/sqs-queue";
import { createSsmAgentCoreDispatchEnablementControl } from "@mymemo/agentcore-dispatch/ssm-control";
import { createDatabaseAgentCoreAcquisitionBoundary } from "./acquisition-boundary";
import { createBedrockAgentCoreRuntimeInvoker } from "./aws-adapters";
import {
	createRetryableAsyncSingleton,
	type Env,
	requireEnv,
} from "./config-utils";
import {
	type AgentCoreDispatchAlarm,
	createAgentCoreDispatchConsumer,
} from "./consumer";
import {
	createAgentCoreConsumerHandler,
	createAgentCorePublisherHandler,
	createManualReplayHandler,
	type LambdaContext,
} from "./handlers";
import {
	type CurrentSecretReader,
	createAwsCurrentSecretReader,
	exactSecretArn,
	verifiedDatabaseUrl,
} from "./secret-config";

export interface AgentCoreDispatchPublisherConfig {
	agentDatabaseUrl: string;
	awsRegion: string;
	queueUrl: string;
	enabledParameterName: string;
}

export interface AgentCoreDispatchConfig
	extends AgentCoreDispatchPublisherConfig {
	agentRuntimeArn: string;
}

export function loadAgentCoreDispatchPublisherConfigFromEnv(
	env: Env,
): AgentCoreDispatchPublisherConfig {
	return {
		agentDatabaseUrl: requireEnv(env, "AGENT_DATABASE_URL"),
		awsRegion: requireEnv(env, "AWS_REGION"),
		queueUrl: requireEnv(env, "AGENTCORE_DISPATCH_QUEUE_URL"),
		enabledParameterName: requireEnv(
			env,
			"AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME",
		),
	};
}

export function loadAgentCoreDispatchConfigFromEnv(
	env: Env,
): AgentCoreDispatchConfig {
	return {
		...loadAgentCoreDispatchPublisherConfigFromEnv(env),
		agentRuntimeArn: requireEnv(env, "AGENTCORE_RUNTIME_ARN"),
	};
}

export async function resolveAgentCoreDispatchConfigFromSecretArns(
	env: Env,
	readCurrentSecret: CurrentSecretReader,
): Promise<AgentCoreDispatchConfig> {
	return {
		...(await resolveAgentCoreDispatchPublisherConfigFromSecretArns(
			env,
			readCurrentSecret,
		)),
		agentRuntimeArn: requireEnv(env, "AGENTCORE_RUNTIME_ARN"),
	};
}

export async function resolveAgentCoreDispatchPublisherConfigFromSecretArns(
	env: Env,
	readCurrentSecret: CurrentSecretReader,
): Promise<AgentCoreDispatchPublisherConfig> {
	const secretArn = exactSecretArn(
		env.AGENT_DATABASE_URL_SECRET_ARN,
		"AGENT_DATABASE_URL_SECRET_ARN",
	);
	return loadAgentCoreDispatchPublisherConfigFromEnv({
		...env,
		AGENT_DATABASE_URL: verifiedDatabaseUrl(
			await readCurrentSecret(secretArn),
			"AGENT_DATABASE_URL",
		),
	});
}

export function createEmbeddedMetricAgentCoreDispatchAlarm(
	log: (record: string) => void = console.error,
): AgentCoreDispatchAlarm {
	return {
		async raise(input): Promise<void> {
			const metricName =
				input.reason === "disabled_delivery"
					? "DisabledDelivery"
					: "PoisonDispatch";
			log(
				JSON.stringify({
					_aws: {
						Timestamp: Date.now(),
						CloudWatchMetrics: [
							{
								Namespace: "MyMemo/AgentCoreDispatch",
								Dimensions: [[], ["reason"]],
								Metrics: [{ Name: metricName, Unit: "Count" }],
							},
						],
					},
					...input,
					[metricName]: 1,
				}),
			);
		},
	};
}

function createProductionPublisherResources(
	config: AgentCoreDispatchPublisherConfig,
) {
	const db = createDatabase(config.agentDatabaseUrl);
	const control = createSsmAgentCoreDispatchEnablementControl({
		client: new SSMClient({ region: config.awsRegion }),
		parameterName: config.enabledParameterName,
	});
	const queue = createSqsAgentCoreDispatchQueue({
		client: new SQSClient({ region: config.awsRegion }),
		queueUrl: config.queueUrl,
	});
	const store = createDatabaseAgentCoreDispatchPublisherStore({ db });
	return {
		db,
		control,
		publish: async (publisherId: string, runId?: string) =>
			await createAgentCoreDispatchPublisher({
				publisherId,
				control,
				store,
				queue,
			}).publishPending({ runId }),
	};
}

export function createAgentCoreDispatchProductionPublisher(
	config: AgentCoreDispatchPublisherConfig,
) {
	return createProductionPublisherResources(config).publish;
}

export function createAgentCoreDispatchProductionServices(
	config: AgentCoreDispatchConfig,
) {
	const { db, control, publish } = createProductionPublisherResources(config);
	const acquisition = createDatabaseAgentCoreAcquisitionBoundary({
		db,
		bootId: crypto.randomUUID(),
		control,
	});
	const consumer = createAgentCoreDispatchConsumer({
		control,
		loadRunStatus: async (dispatch) =>
			await loadAgentCoreDispatchRunStatus(db, dispatch),
		runtime: createBedrockAgentCoreRuntimeInvoker({
			client: new BedrockAgentCoreClient({ region: config.awsRegion }),
			agentRuntimeArn: config.agentRuntimeArn,
		}),
		alarm: createEmbeddedMetricAgentCoreDispatchAlarm(),
	});

	return {
		publish,
		consume: consumer.handle,
		acquire: acquisition.handle,
		replay: async (input: { runId: string; requestedBy: string }) =>
			await requestAgentCoreDispatchReplayTx(db, input),
	};
}

const services = createRetryableAsyncSingleton(async () => {
	const config = await resolveAgentCoreDispatchConfigFromSecretArns(
		process.env,
		createAwsCurrentSecretReader(requireEnv(process.env, "AWS_REGION")),
	);
	return createAgentCoreDispatchProductionServices(config);
});

const publisher = createRetryableAsyncSingleton(async () => {
	const config = await resolveAgentCoreDispatchPublisherConfigFromSecretArns(
		process.env,
		createAwsCurrentSecretReader(requireEnv(process.env, "AWS_REGION")),
	);
	return createAgentCoreDispatchProductionPublisher(config);
});

export async function publisherHandler(event: unknown, context: LambdaContext) {
	return await createAgentCorePublisherHandler({
		publish: await publisher(),
	})(event, context);
}

export async function consumerHandler(event: unknown) {
	return await createAgentCoreConsumerHandler({
		handle: (await services()).consume,
	})(event);
}

export async function manualReplayHandler(
	event: unknown,
	context: LambdaContext,
) {
	const current = await services();
	return await createManualReplayHandler({
		replay: current.replay,
		publish: current.publish,
	})(event, context);
}

/** Raw request-body boundary mounted on AgentCore's `/invocations` in #451. */
export async function runtimeAcquisitionHandler(rawEnvelope: string) {
	return await (await services()).acquire(rawEnvelope);
}
