import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";

type Env = Record<string, string | undefined>;

export interface AgentCoreDispatchPublisherConfig {
	agentDatabaseUrl: string;
	awsRegion: string;
	queueUrl: string;
	enabledParameterName: string;
	intervalMs: number;
	logLevel: string;
}

const DEFAULT_INTERVAL_MS = 2_000;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function required(env: Env, name: string): string {
	const value = env[name];
	assert(value, `${name} is required`);
	assert(
		value === value.trim(),
		`${name} must not contain surrounding whitespace`,
	);
	return value;
}

function validateDatabaseUrl(value: string): string {
	try {
		const url = new URL(value);
		assert(
			(url.protocol === "postgres:" || url.protocol === "postgresql:") &&
				url.hostname !== "" &&
				url.username !== "" &&
				url.pathname !== "/",
			"invalid",
		);
		return value;
	} catch {
		throw new Error("AGENT_DATABASE_URL must be a valid PostgreSQL URL");
	}
}

function validateAwsRegion(value: string): string {
	assert(
		/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(value),
		"AWS_REGION must be a valid AWS region",
	);
	return value;
}

function validateQueueUrl(value: string, region: string): string {
	try {
		const url = new URL(value);
		const hostname = region.startsWith("cn-")
			? `sqs.${region}.amazonaws.com.cn`
			: `sqs.${region}.amazonaws.com`;
		const path = /^\/(\d{12})\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
		assert(
			url.protocol === "https:" &&
				url.hostname === hostname &&
				url.port === "" &&
				url.username === "" &&
				url.password === "" &&
				url.search === "" &&
				url.hash === "" &&
				path !== null,
			"invalid",
		);
		return value;
	} catch {
		throw new Error(
			"CANARY_DISPATCH_QUEUE_URL must be an HTTPS SQS URL in AWS_REGION",
		);
	}
}

function validateParameterName(value: string): string {
	assert(
		/^[A-Za-z0-9_.\-/]+$/.test(value),
		"CANARY_ENABLED_PARAMETER_NAME must be a valid SSM parameter name",
	);
	return value;
}

function positiveIntOr(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	assert(
		Number.isInteger(value) && value > 0,
		`${name} must be a positive integer (got: ${raw})`,
	);
	return value;
}

/** Load only the database and AWS dispatch authority owned by this app. */
export function loadAgentCoreDispatchPublisherConfigFromEnv(
	env: Env,
): AgentCoreDispatchPublisherConfig {
	const rawDatabaseUrl = required(env, "AGENT_DATABASE_URL");
	const awsRegion = validateAwsRegion(required(env, "AWS_REGION"));
	const queueUrl = validateQueueUrl(
		required(env, "CANARY_DISPATCH_QUEUE_URL"),
		awsRegion,
	);
	const enabledParameterName = validateParameterName(
		required(env, "CANARY_ENABLED_PARAMETER_NAME"),
	);
	const agentDatabaseUrl = validateDatabaseUrl(
		resolveDatabaseUrl(rawDatabaseUrl, env.DB_PASSWORD, env.DB_SSL),
	);

	return {
		agentDatabaseUrl,
		awsRegion,
		queueUrl,
		enabledParameterName,
		intervalMs: positiveIntOr(
			env.AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS,
			DEFAULT_INTERVAL_MS,
			"AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS",
		),
		logLevel: env.LOG_LEVEL ?? "info",
	};
}
