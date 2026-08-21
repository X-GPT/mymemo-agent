import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { SSMClient } from "@aws-sdk/client-ssm";
import { loadAgentCoreDispatchRunStatus } from "@mymemo/agent-db/agentcore-dispatch";
import { createDatabase } from "@mymemo/agent-db/client";
import { createSsmAgentCoreDispatchEnablementControl } from "@mymemo/agentcore-dispatch/ssm-control";
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
import { createAgentCoreConsumerHandler } from "./handlers";
import {
	type CurrentSecretReader,
	createAwsCurrentSecretReader,
	resolveVerifiedAgentDatabaseUrl,
} from "./secret-config";

export interface AgentCoreDispatchConfig {
	agentDatabaseUrl: string;
	awsRegion: string;
	enabledParameterName: string;
	agentRuntimeArn: string;
}

export function loadAgentCoreDispatchConfigFromEnv(
	env: Env,
): AgentCoreDispatchConfig {
	return {
		agentDatabaseUrl: requireEnv(env, "AGENT_DATABASE_URL"),
		awsRegion: requireEnv(env, "AWS_REGION"),
		enabledParameterName: requireEnv(
			env,
			"AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME",
		),
		agentRuntimeArn: requireEnv(env, "AGENTCORE_RUNTIME_ARN"),
	};
}

export async function resolveAgentCoreDispatchConfigFromSecretArns(
	env: Env,
	readCurrentSecret: CurrentSecretReader,
): Promise<AgentCoreDispatchConfig> {
	const passwordSecretArn = requireEnv(env, "DB_PASSWORD_SECRET_ARN");
	return loadAgentCoreDispatchConfigFromEnv({
		...env,
		AGENT_DATABASE_URL: resolveVerifiedAgentDatabaseUrl(
			requireEnv(env, "AGENT_DATABASE_URL"),
			await readCurrentSecret(passwordSecretArn),
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

export function createAgentCoreDispatchProductionConsumer(
	config: AgentCoreDispatchConfig,
) {
	const db = createDatabase(config.agentDatabaseUrl);
	const control = createSsmAgentCoreDispatchEnablementControl({
		client: new SSMClient({ region: config.awsRegion }),
		parameterName: config.enabledParameterName,
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

	return consumer.handle;
}

const consumer = createRetryableAsyncSingleton(async () => {
	const config = await resolveAgentCoreDispatchConfigFromSecretArns(
		process.env,
		createAwsCurrentSecretReader(requireEnv(process.env, "AWS_REGION")),
	);
	return createAgentCoreDispatchProductionConsumer(config);
});

export async function consumerHandler(event: unknown) {
	return await createAgentCoreConsumerHandler({
		handle: await consumer(),
	})(event);
}
