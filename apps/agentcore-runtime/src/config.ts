import {
	loadWorkerConfigFromEnv,
	type WorkerConfig,
} from "agent-worker/config";
import { type Env, requireEnv } from "agentcore-dispatch-consumer/config-utils";
import {
	exactSecretArn,
	verifiedDatabaseUrl,
} from "agentcore-dispatch-consumer/secret-config";
import { RUNTIME_SHUTDOWN_TIMEOUT_MS } from "./constants";

const AMBIENT_SECRET_NAMES = [
	"AGENT_DATABASE_URL",
	"KB_DATABASE_URL",
	"OPENROUTER_API_KEY",
	"E2B_API_KEY",
	"REDIS_URL",
] as const;

export interface RuntimeBootstrapConfig {
	awsRegion: string;
	enabledParameterName: string;
	secretArns: {
		agentDatabaseUrl: string;
		kbDatabaseUrl: string;
		openrouterApiKey: string;
		e2bApiKey: string;
		redisUrl: string;
	};
	openrouterBaseUrl: string;
	openrouterDefaultModel: string;
	e2bTemplate: string;
	artifactBucket: string;
	rdsCaBundlePath: string;
	port: number;
	heartbeatIntervalMs: number;
	shutdownTimeoutMs: typeof RUNTIME_SHUTDOWN_TIMEOUT_MS;
	logLevel: string;
}

function secretArn(env: Env, name: string): string {
	return exactSecretArn(requireEnv(env, name), name);
}

function positiveInt(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

export function loadRuntimeBootstrapConfig(env: Env): RuntimeBootstrapConfig {
	for (const name of AMBIENT_SECRET_NAMES) {
		if (env[name] !== undefined) {
			throw new Error(`${name} must be read from Secrets Manager, not env`);
		}
	}
	const rdsCaBundlePath = requireEnv(env, "RDS_CA_BUNDLE_PATH");
	if (!rdsCaBundlePath.startsWith("/")) {
		throw new Error("RDS_CA_BUNDLE_PATH must be absolute");
	}
	if (env.NODE_EXTRA_CA_CERTS !== rdsCaBundlePath) {
		throw new Error(
			"NODE_EXTRA_CA_CERTS must name the configured RDS CA bundle",
		);
	}

	return {
		awsRegion: requireEnv(env, "AWS_REGION"),
		enabledParameterName: requireEnv(
			env,
			"AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME",
		),
		secretArns: {
			agentDatabaseUrl: secretArn(env, "AGENT_DATABASE_URL_SECRET_ARN"),
			kbDatabaseUrl: secretArn(env, "KB_DATABASE_URL_SECRET_ARN"),
			openrouterApiKey: secretArn(env, "OPENROUTER_API_KEY_SECRET_ARN"),
			e2bApiKey: secretArn(env, "E2B_API_KEY_SECRET_ARN"),
			redisUrl: secretArn(env, "REDIS_URL_SECRET_ARN"),
		},
		openrouterBaseUrl: requireEnv(env, "OPENROUTER_BASE_URL"),
		openrouterDefaultModel: requireEnv(env, "OPENROUTER_DEFAULT_MODEL"),
		e2bTemplate: requireEnv(env, "WORKER_E2B_TEMPLATE"),
		artifactBucket: requireEnv(env, "ARTIFACT_BUCKET"),
		rdsCaBundlePath,
		port: positiveInt(env.PORT, 8080, "PORT"),
		heartbeatIntervalMs: positiveInt(
			env.WORKER_HEARTBEAT_INTERVAL_MS,
			15_000,
			"WORKER_HEARTBEAT_INTERVAL_MS",
		),
		shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
		logLevel: env.LOG_LEVEL || "info",
	};
}

/** Resolve AWSCURRENT secret values once for this fresh Runtime session and
 * adapt them to the existing validated worker execution configuration. */
export async function resolveRuntimeWorkerConfig(
	bootstrap: RuntimeBootstrapConfig,
	readCurrentSecret: (arn: string) => Promise<string>,
): Promise<WorkerConfig> {
	const [
		agentDatabaseUrl,
		kbDatabaseUrl,
		openrouterApiKey,
		e2bApiKey,
		redisUrl,
	] = await Promise.all([
		readCurrentSecret(bootstrap.secretArns.agentDatabaseUrl),
		readCurrentSecret(bootstrap.secretArns.kbDatabaseUrl),
		readCurrentSecret(bootstrap.secretArns.openrouterApiKey),
		readCurrentSecret(bootstrap.secretArns.e2bApiKey),
		readCurrentSecret(bootstrap.secretArns.redisUrl),
	]);

	return loadWorkerConfigFromEnv({
		AGENT_DATABASE_URL: verifiedDatabaseUrl(
			agentDatabaseUrl,
			"AGENT_DATABASE_URL",
		),
		KB_DATABASE_URL: verifiedDatabaseUrl(kbDatabaseUrl, "KB_DATABASE_URL"),
		OPENROUTER_API_KEY: openrouterApiKey,
		OPENROUTER_BASE_URL: bootstrap.openrouterBaseUrl,
		OPENROUTER_DEFAULT_MODEL: bootstrap.openrouterDefaultModel,
		E2B_API_KEY: e2bApiKey,
		WORKER_E2B_TEMPLATE: bootstrap.e2bTemplate,
		ARTIFACT_BUCKET: bootstrap.artifactBucket,
		AWS_REGION: bootstrap.awsRegion,
		REDIS_URL: redisUrl,
		WORKER_MAX_CONCURRENT_CONVERSATIONS: "1",
		WORKER_HEARTBEAT_INTERVAL_MS: String(bootstrap.heartbeatIntervalMs),
		WORKER_SHUTDOWN_TIMEOUT_MS: String(bootstrap.shutdownTimeoutMs),
		LOG_LEVEL: bootstrap.logLevel,
		PORT: String(bootstrap.port),
	});
}
