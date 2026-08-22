import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";

type Env = Record<string, string | undefined>;

export interface MaintenanceConfig {
	agentDatabaseUrl: string;
	e2bApiKey: string;
	artifact: {
		bucket: string;
		region: string;
	};
	logLevel: string;
	port: number;
}

const DEFAULT_PORT = 8080;
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function required(env: Env, name: string): string {
	const value = env[name];
	assert(value, `${name} is required`);
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
		Number.isInteger(value) && value > 0 && value <= MAX_TIMER_INTERVAL_MS,
		`${name} must be a positive integer no greater than ${MAX_TIMER_INTERVAL_MS} (got: ${raw})`,
	);
	return value;
}

/** Load only the credentials and settings required by global maintenance. */
export function loadMaintenanceConfigFromEnv(env: Env): MaintenanceConfig {
	const region = required(env, "AWS_REGION");
	return {
		agentDatabaseUrl: resolveDatabaseUrl(
			required(env, "AGENT_DATABASE_URL"),
			env.DB_PASSWORD,
			env.DB_SSL,
		),
		e2bApiKey: required(env, "E2B_API_KEY"),
		artifact: {
			bucket: required(env, "ARTIFACT_BUCKET"),
			region,
		},
		logLevel: env.LOG_LEVEL ?? "info",
		port: positiveIntOr(env.PORT, DEFAULT_PORT, "PORT"),
	};
}
