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

type Env = Record<string, string | undefined>;

export interface CanaryDispatchConfig {
	agentDatabaseUrl: string;
	awsRegion: string;
	queueUrl: string;
	enabledParameterName: string;
	agentRuntimeArn: string;
}

function requireEnv(env: Env, name: string): string {
	const value = env[name];
	if (!value || value.trim() === "") throw new Error(`${name} is required`);
	return value;
}

export function loadCanaryDispatchConfigFromEnv(
	env: Env,
): CanaryDispatchConfig {
	return {
		agentDatabaseUrl: requireEnv(env, "AGENT_DATABASE_URL"),
		awsRegion: requireEnv(env, "AWS_REGION"),
		queueUrl: requireEnv(env, "CANARY_DISPATCH_QUEUE_URL"),
		enabledParameterName: requireEnv(env, "CANARY_ENABLED_PARAMETER_NAME"),
		agentRuntimeArn: requireEnv(env, "CANARY_AGENT_RUNTIME_ARN"),
	};
}

export function createEmbeddedMetricCanaryDispatchAlarm(
	log: (record: string) => void = console.error,
): CanaryDispatchAlarm {
	return {
		async raise(input): Promise<void> {
			log(
				JSON.stringify({
					_aws: {
						Timestamp: Date.now(),
						CloudWatchMetrics: [
							{
								Namespace: "MyMemo/AgentCoreCanary",
								Dimensions: [["reason"]],
								Metrics: [{ Name: "PoisonDispatch", Unit: "Count" }],
							},
						],
					},
					...input,
					PoisonDispatch: 1,
				}),
			);
		},
	};
}

export function createCanaryDispatchProductionServices(
	config: CanaryDispatchConfig,
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
		publish: async (publisherId: string) =>
			await createCanaryDispatchPublisher({
				publisherId,
				control,
				store,
				queue,
			}).publishPending(),
		consume: consumer.handle,
		acquire: acquisition.handle,
		replay: async (input: { dispatchId: string; requestedBy: string }) =>
			await requestCanaryDispatchReplayTx(db, input),
	};
}

let productionServices:
	| ReturnType<typeof createCanaryDispatchProductionServices>
	| undefined;

function services() {
	productionServices ??= createCanaryDispatchProductionServices(
		loadCanaryDispatchConfigFromEnv(process.env),
	);
	return productionServices;
}

export async function publisherHandler(event: unknown, context: LambdaContext) {
	return await createCanaryPublisherHandler({ publish: services().publish })(
		event,
		context,
	);
}

export async function consumerHandler(event: unknown) {
	return await createCanaryConsumerHandler({ handle: services().consume })(
		event,
	);
}

export async function manualReplayHandler(
	event: unknown,
	context: LambdaContext,
) {
	const current = services();
	return await createManualReplayHandler({
		replay: current.replay,
		publish: current.publish,
	})(event, context);
}

/** Raw request-body boundary mounted on AgentCore's `/invocations` in #451. */
export async function runtimeAcquisitionHandler(rawEnvelope: string) {
	return await services().acquire(rawEnvelope);
}
