import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { createLogger } from "agent-worker/logger";
import { createProductionRunResources } from "agent-worker/production-run-resources";
import { createRunServing } from "agent-worker/run-serving";
import { createDatabaseCanaryAcquisitionBoundary } from "agentcore-canary-dispatch/acquisition-boundary";
import { createSsmCanaryEnablementControl } from "agentcore-canary-dispatch/aws-adapters";
import {
	loadRuntimeBootstrapConfig,
	type RuntimeBootstrapConfig,
	resolveRuntimeWorkerConfig,
} from "./config";
import { createCanaryExecutionServices } from "./execution-services";
import { createCanaryRuntime } from "./runtime";

interface SecretCommandClient {
	send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

export function createCurrentSecretReader(client: SecretCommandClient) {
	return async (secretArn: string): Promise<string> => {
		const value = await client.send(
			new GetSecretValueCommand({ SecretId: secretArn }),
		);
		if (value.SecretString === undefined || value.SecretString === "") {
			throw new Error("Runtime secret has no current string value");
		}
		return value.SecretString;
	};
}

export function createProductionCanaryRuntime(options: {
	bootstrap: RuntimeBootstrapConfig;
	bootId: string;
	processEnv: Record<string, string | undefined>;
	readCurrentSecret(arn: string): Promise<string>;
	ssmClient: SSMClient;
}) {
	const logger = createLogger(options.bootstrap.logLevel);
	type Services = Awaited<ReturnType<typeof createServices>>;
	let servicePromise: Promise<Services> | undefined;

	async function createServices() {
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
		return {
			...createCanaryExecutionServices({
				db: resources.db,
				acquire: acquisition.acquire,
				runServing,
				logger,
			}),
			async close() {
				await resources.liveStreamRelay.close().catch(() => {});
				const pool = resources.db.$client as unknown as {
					end(): Promise<void>;
				};
				await pool.end().catch(() => {});
			},
		};
	}

	function services(): Promise<Services> {
		servicePromise ??= createServices().catch((error) => {
			servicePromise = undefined;
			throw error;
		});
		return servicePromise;
	}

	const runtime = createCanaryRuntime({
		acquire: async (rawEnvelope) =>
			await (await services()).acquire(rawEnvelope),
		serve: async (input) => await (await services()).serve(input),
		heartbeat: async (input) => await (await services()).heartbeat(input),
		release: async (input) => await (await services()).release(input),
		onExecutionError(error, dispatch) {
			logger.error({
				message: "AgentCore one-shot execution abandoned",
				dispatchId: dispatch.dispatchId,
				conversationId: dispatch.conversationId,
				runId: dispatch.runId,
				error: error instanceof Error ? error.message : String(error),
			});
		},
		heartbeatIntervalMs: options.bootstrap.heartbeatIntervalMs,
	});

	return {
		runtime,
		logger,
		async close(): Promise<void> {
			const current = servicePromise;
			if (!current) return;
			await (await current).close();
		},
	};
}

export function createProductionCanaryRuntimeFromEnv(
	env: Record<string, string | undefined> = Bun.env,
) {
	const bootstrap = loadRuntimeBootstrapConfig(env);
	const secretClient = new SecretsManagerClient({
		region: bootstrap.awsRegion,
	});
	return {
		bootstrap,
		...createProductionCanaryRuntime({
			bootstrap,
			bootId: crypto.randomUUID(),
			processEnv: env,
			readCurrentSecret: createCurrentSecretReader(secretClient),
			ssmClient: new SSMClient({ region: bootstrap.awsRegion }),
		}),
	};
}
