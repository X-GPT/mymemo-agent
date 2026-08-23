import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { createSsmAgentCoreDispatchEnablementControl } from "@mymemo/agentcore-dispatch/ssm-control";
import { createDatabaseAgentCoreAcquisitionBoundary } from "agentcore-dispatch-consumer/acquisition-boundary";
import { createCurrentSecretReader } from "agentcore-dispatch-consumer/secret-config";
import {
	loadRuntimeBootstrapConfig,
	type RuntimeBootstrapConfig,
	resolveRuntimeConfig,
} from "./config";
import { createAgentCoreExecutionServices } from "./execution-services";
import { createLogger, toMessage } from "./logger";
import { createProductionRunResources } from "./production-run-resources";
import { createRunServing } from "./run-serving";
import { createAgentCoreRuntime } from "./runtime";

export async function createProductionAgentCoreRuntime(options: {
	bootstrap: RuntimeBootstrapConfig;
	bootId: string;
	processEnv: Record<string, string | undefined>;
	readCurrentSecret(arn: string): Promise<string>;
	ssmClient: SSMClient;
}) {
	const logger = createLogger(options.bootstrap.logLevel);
	const runtimeConfig = await resolveRuntimeConfig(
		options.bootstrap,
		options.readCurrentSecret,
	);
	const resources = createProductionRunResources({
		config: runtimeConfig,
		logger,
		processEnv: options.processEnv,
		telemetryService: "agentcore-runtime",
	});
	const control = createSsmAgentCoreDispatchEnablementControl({
		client: options.ssmClient,
		parameterName: options.bootstrap.enabledParameterName,
	});
	const acquisition = createDatabaseAgentCoreAcquisitionBoundary({
		db: resources.db,
		bootId: options.bootId,
		control,
	});
	const runServing = createRunServing({
		db: resources.db,
		processor: resources.processor,
		liveStreamRelay: resources.liveStreamRelay,
		liveStreamTelemetry: resources.liveStreamTelemetry,
		logger,
	});
	const services = createAgentCoreExecutionServices({
		db: resources.db,
		acquire: acquisition.acquireDispatch,
		runServing,
		logger,
	});

	const runtime = createAgentCoreRuntime({
		...services,
		onExecutionError(error, dispatch) {
			logger.error({
				message: "AgentCore one-shot execution abandoned",
				conversationId: dispatch.conversationId,
				runId: dispatch.runId,
				error: toMessage(error),
			});
		},
		heartbeatIntervalMs: options.bootstrap.heartbeatIntervalMs,
	});

	return {
		runtime,
		logger,
		async close(): Promise<void> {
			await resources.liveStreamRelay.close().catch(() => {});
			await resources.db.$client.end().catch(() => {});
		},
	};
}

export async function createProductionAgentCoreRuntimeFromEnv(
	env: Record<string, string | undefined> = Bun.env,
) {
	const bootstrap = loadRuntimeBootstrapConfig(env);
	const secretClient = new SecretsManagerClient({
		region: bootstrap.awsRegion,
	});
	try {
		return {
			bootstrap,
			...(await createProductionAgentCoreRuntime({
				bootstrap,
				bootId: crypto.randomUUID(),
				processEnv: env,
				readCurrentSecret: createCurrentSecretReader(secretClient),
				ssmClient: new SSMClient({ region: bootstrap.awsRegion }),
			})),
		};
	} finally {
		secretClient.destroy();
	}
}
