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

function withPassword(url: string, password: string | undefined): string {
	if (!password) return url;
	const match = /^([a-z]+:\/\/)([^@/]+)@(.*)$/i.exec(url);
	if (!match) return url;
	const [, scheme, userinfo, rest] = match;
	if (!scheme || !userinfo || rest === undefined || userinfo.includes(":")) {
		return url;
	}
	return `${scheme}${userinfo}:${encodeURIComponent(password)}@${rest}`;
}

function withSsl(url: string, enabled: boolean): string {
	if (!enabled || /[?&]sslmode=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}sslmode=no-verify`;
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
	assert(env.AGENT_DATABASE_URL, "AGENT_DATABASE_URL is required");
	assert(env.AWS_REGION, "AWS_REGION is required");
	assert(
		env.CANARY_DISPATCH_QUEUE_URL,
		"CANARY_DISPATCH_QUEUE_URL is required",
	);
	assert(
		env.CANARY_ENABLED_PARAMETER_NAME,
		"CANARY_ENABLED_PARAMETER_NAME is required",
	);

	return {
		agentDatabaseUrl: withSsl(
			withPassword(env.AGENT_DATABASE_URL, env.DB_PASSWORD),
			env.DB_SSL !== "disable",
		),
		awsRegion: env.AWS_REGION,
		queueUrl: env.CANARY_DISPATCH_QUEUE_URL,
		enabledParameterName: env.CANARY_ENABLED_PARAMETER_NAME,
		intervalMs: positiveIntOr(
			env.AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS,
			DEFAULT_INTERVAL_MS,
			"AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS",
		),
		logLevel: env.LOG_LEVEL ?? "info",
	};
}
