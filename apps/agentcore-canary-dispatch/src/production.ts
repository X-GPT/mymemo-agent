import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { requestCanaryDispatchReplayTx } from "@mymemo/agent-db/canary-dispatch";
import { createDatabase } from "@mymemo/agent-db/client";
import { createDatabaseCanaryAcquisitionBoundary } from "./acquisition-boundary";
import {
	createBedrockAgentCoreRuntimeInvoker,
	createDatabaseCanaryDispatchPublisherStore,
	createSqsCanaryDispatchQueue,
	createSsmCanaryEnablementControl,
} from "./aws-adapters";
import {
	type CanaryDispatchAlarm,
	createCanaryDispatchConsumer,
} from "./consumer";
import {
	createCanaryConsumerHandler,
	createCanaryPublisherHandler,
	createManualReplayHandler,
	type LambdaContext,
} from "./handlers";
import { createCanaryDispatchPublisher } from "./publisher";
import {
	type CurrentSecretReader,
	createAwsCurrentSecretReader,
	exactSecretArn,
	requireEnv,
	verifiedDatabaseUrl,
} from "./secret-config";

type Env = Record<string, string | undefined>;

export interface CanaryDispatchPublisherConfig {
	agentDatabaseUrl: string;
	awsRegion: string;
	queueUrl: string;
	enabledParameterName: string;
}

export interface CanaryDispatchConfig extends CanaryDispatchPublisherConfig {
	agentRuntimeArn: string;
}

export function loadCanaryDispatchPublisherConfigFromEnv(
	env: Env,
): CanaryDispatchPublisherConfig {
	return {
		agentDatabaseUrl: requireEnv(env, "AGENT_DATABASE_URL"),
		awsRegion: requireEnv(env, "AWS_REGION"),
		queueUrl: requireEnv(env, "CANARY_DISPATCH_QUEUE_URL"),
		enabledParameterName: requireEnv(env, "CANARY_ENABLED_PARAMETER_NAME"),
	};
}

export function loadCanaryDispatchConfigFromEnv(
	env: Env,
): CanaryDispatchConfig {
	return {
		...loadCanaryDispatchPublisherConfigFromEnv(env),
		agentRuntimeArn: requireEnv(env, "CANARY_AGENT_RUNTIME_ARN"),
	};
}

export async function resolveCanaryDispatchConfigFromSecretArns(
	env: Env,
	readCurrentSecret: CurrentSecretReader,
): Promise<CanaryDispatchConfig> {
	const secretArn = exactSecretArn(
		env.CANARY_AGENT_DATABASE_URL_SECRET_ARN,
		"CANARY_AGENT_DATABASE_URL_SECRET_ARN",
	);
	return loadCanaryDispatchConfigFromEnv({
		...env,
		AGENT_DATABASE_URL: verifiedDatabaseUrl(
			await readCurrentSecret(secretArn),
			"AGENT_DATABASE_URL",
		),
	});
}

export function createEmbeddedMetricCanaryDispatchAlarm(
	log: (record: string) => void = console.error,
): CanaryDispatchAlarm {
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
								Namespace: "MyMemo/AgentCoreCanary",
								Dimensions: [["reason"]],
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
	config: CanaryDispatchPublisherConfig,
) {
	const db = createDatabase(config.agentDatabaseUrl);
	const control = createSsmCanaryEnablementControl({
		client: new SSMClient({ region: config.awsRegion }),
		parameterName: config.enabledParameterName,
	});
	const queue = createSqsCanaryDispatchQueue({
		client: new SQSClient({ region: config.awsRegion }),
		queueUrl: config.queueUrl,
	});
	const store = createDatabaseCanaryDispatchPublisherStore({ db });
	return {
		db,
		control,
		publish: async (publisherId: string, dispatchId?: string) =>
			await createCanaryDispatchPublisher({
				publisherId,
				control,
				store,
				queue,
			}).publishPending({ dispatchId }),
	};
}

export function createCanaryDispatchProductionPublisher(
	config: CanaryDispatchPublisherConfig,
) {
	return createProductionPublisherResources(config).publish;
}

export function createCanaryDispatchProductionServices(
	config: CanaryDispatchConfig,
) {
	const { db, control, publish } = createProductionPublisherResources(config);
	const acquisition = createDatabaseCanaryAcquisitionBoundary({
		db,
		bootId: crypto.randomUUID(),
		control,
	});
	const consumer = createCanaryDispatchConsumer({
		control,
		runtime: createBedrockAgentCoreRuntimeInvoker({
			client: new BedrockAgentCoreClient({ region: config.awsRegion }),
			agentRuntimeArn: config.agentRuntimeArn,
		}),
		alarm: createEmbeddedMetricCanaryDispatchAlarm(),
	});

	return {
		publish,
		consume: consumer.handle,
		acquire: acquisition.handle,
		replay: async (input: { dispatchId: string; requestedBy: string }) =>
			await requestCanaryDispatchReplayTx(db, input),
	};
}

let productionServicesPromise:
	| Promise<ReturnType<typeof createCanaryDispatchProductionServices>>
	| undefined;

async function services() {
	productionServicesPromise ??= resolveCanaryDispatchConfigFromSecretArns(
		process.env,
		createAwsCurrentSecretReader(requireEnv(process.env, "AWS_REGION")),
	).then((config) => createCanaryDispatchProductionServices(config));
	return await productionServicesPromise;
}

export async function publisherHandler(event: unknown, context: LambdaContext) {
	return await createCanaryPublisherHandler({
		publish: (await services()).publish,
	})(event, context);
}

export async function consumerHandler(event: unknown) {
	return await createCanaryConsumerHandler({
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
