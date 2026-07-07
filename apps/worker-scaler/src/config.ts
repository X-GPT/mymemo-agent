type Env = Record<string, string | undefined>;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export interface WorkerScalerAppConfig {
	agentDatabaseUrl: string;
	awsRegion: string;
	ecsCluster: string;
	ecsService: string;
	scaler: {
		minTasks: number;
		maxTasks: number;
		targetConcurrentRunsPerTask: number;
		scaleInCooldownMs: number;
	};
}

const DEFAULT_MIN_TASKS = 1;
const DEFAULT_TARGET_CONCURRENT_RUNS_PER_TASK = 2;
const DEFAULT_SCALE_IN_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Append `sslmode=no-verify` unless TLS is disabled or the URL already sets it.
 * We want the connection encrypted but not CA-verified: RDS presents the Amazon
 * RDS CA, which is not in Node's default trust store. node-postgres's
 * pg-connection-string aliases `sslmode=require` to `verify-full` (strict
 * CA-chain verification), so `require` fails with SELF_SIGNED_CERT_IN_CHAIN;
 * `no-verify` maps to `rejectUnauthorized: false`. Do not change back to
 * `require` without also shipping the RDS CA bundle (e.g. NODE_EXTRA_CA_CERTS).
 */
function withSsl(url: string, enabled: boolean): string {
	if (!enabled || /[?&]sslmode=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}sslmode=no-verify`;
}

function withPassword(url: string, password: string | undefined): string {
	if (!password) return url;
	const m = /^([a-z]+:\/\/)([^@/]+)@(.*)$/i.exec(url);
	if (!m) return url;
	const [, scheme, userinfo, rest] = m;
	if (!scheme || !userinfo || rest === undefined) return url;
	if (userinfo.includes(":")) return url;
	return `${scheme}${userinfo}:${encodeURIComponent(password)}@${rest}`;
}

function positiveIntOr(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	assert(
		Number.isInteger(n) && n > 0,
		`${name} must be a positive integer (got: ${raw})`,
	);
	return n;
}

function positiveRequiredInt(raw: string | undefined, name: string): number {
	assert(raw, `${name} is required`);
	return positiveIntOr(raw, 1, name);
}

export function loadWorkerScalerConfigFromEnv(env: Env): WorkerScalerAppConfig {
	assert(env.AGENT_DATABASE_URL, "AGENT_DATABASE_URL is required");
	assert(env.AWS_REGION, "AWS_REGION is required");
	assert(
		env.WORKER_SCALER_ECS_CLUSTER,
		"WORKER_SCALER_ECS_CLUSTER is required",
	);
	assert(
		env.WORKER_SCALER_ECS_SERVICE,
		"WORKER_SCALER_ECS_SERVICE is required",
	);

	const sslEnabled = env.DB_SSL !== "disable";
	const minTasks = positiveIntOr(
		env.WORKER_SCALER_MIN_TASKS,
		DEFAULT_MIN_TASKS,
		"WORKER_SCALER_MIN_TASKS",
	);
	const maxTasks = positiveRequiredInt(
		env.WORKER_SCALER_MAX_TASKS,
		"WORKER_SCALER_MAX_TASKS",
	);
	assert(
		maxTasks >= minTasks,
		"WORKER_SCALER_MAX_TASKS must be greater than or equal to WORKER_SCALER_MIN_TASKS",
	);

	return {
		agentDatabaseUrl: withSsl(
			withPassword(env.AGENT_DATABASE_URL, env.DB_PASSWORD),
			sslEnabled,
		),
		awsRegion: env.AWS_REGION,
		ecsCluster: env.WORKER_SCALER_ECS_CLUSTER,
		ecsService: env.WORKER_SCALER_ECS_SERVICE,
		scaler: {
			minTasks,
			maxTasks,
			targetConcurrentRunsPerTask: positiveIntOr(
				env.WORKER_SCALER_TARGET_CONCURRENT_RUNS_PER_TASK,
				DEFAULT_TARGET_CONCURRENT_RUNS_PER_TASK,
				"WORKER_SCALER_TARGET_CONCURRENT_RUNS_PER_TASK",
			),
			scaleInCooldownMs: positiveIntOr(
				env.WORKER_SCALER_SCALE_IN_COOLDOWN_MS,
				DEFAULT_SCALE_IN_COOLDOWN_MS,
				"WORKER_SCALER_SCALE_IN_COOLDOWN_MS",
			),
		},
	};
}
