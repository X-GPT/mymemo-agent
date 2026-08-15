import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { createLogger, toMessage } from "agent-worker/logger";
import { createProductionRunResources } from "agent-worker/production-run-resources";
import { createRunServing } from "agent-worker/run-serving";
import { createDatabaseCanaryAcquisitionBoundary } from "agentcore-canary-dispatch/acquisition-boundary";
import { createSsmCanaryEnablementControl } from "agentcore-canary-dispatch/aws-adapters";
import { createCurrentSecretReader } from "agentcore-canary-dispatch/secret-config";
import {
	loadRuntimeBootstrapConfig,
	type RuntimeBootstrapConfig,
	resolveRuntimeWorkerConfig,
} from "./config";
import { createCanaryExecutionServices } from "./execution-services";
import { createCanaryRuntime } from "./runtime";

export async function createProductionCanaryRuntime(options: {
	bootstrap: RuntimeBootstrapConfig;
	bootId: string;
	processEnv: Record<string, string | undefined>;
	readCurrentSecret(arn: string): Promise<string>;
	ssmClient: SSMClient;
}) {
	const logger = createLogger(options.bootstrap.logLevel);
	const workerConfig = await resolveRuntimeWorkerConfig(
		options.bootstrap,
		options.readCurrentSecret,
	);
	const resources = createProductionRunResources({
		config: workerConfig,
		logger,
		processEnv: options.processEnv,
		telemetryService: "agentcore-canary-runtime",
	});
	const control = createSsmCanaryEnablementControl({
		client: options.ssmClient,
		parameterName: options.bootstrap.enabledParameterName,
	});
	const acquisition = createDatabaseCanaryAcquisitionBoundary({
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
	const services = createCanaryExecutionServices({
		db: resources.db,
		acquire: acquisition.acquireDispatch,
		runServing,
		logger,
	});

	const runtime = createCanaryRuntime({
		...services,
		onExecutionError(error, dispatch) {
			logger.error({
				message: "AgentCore one-shot execution abandoned",
				dispatchId: dispatch.dispatchId,
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

export async function createProductionCanaryRuntimeFromEnv(
	env: Record<string, string | undefined> = Bun.env,
) {
	const bootstrap = loadRuntimeBootstrapConfig(env);
	const secretClient = new SecretsManagerClient({
		region: bootstrap.awsRegion,
	});
	try {
		return {
			bootstrap,
			...(await createProductionCanaryRuntime({
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
