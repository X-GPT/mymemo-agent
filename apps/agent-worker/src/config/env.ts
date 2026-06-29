/** Subset of the process environment the worker reads. */
type Env = Record<string, string | undefined>;

/**
 * Assert a config invariant, throwing an Error whose message survives
 * production builds. Deliberately NOT tiny-invariant: that strips the message
 * when NODE_ENV=production, which would turn a misconfigured prod boot into an
 * opaque "Invariant failed" instead of naming the missing variable.
 */
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/**
 * Typed, validated configuration for `agent-worker`. Built once from the
 * environment at the entrypoint and injected down, mirroring chat-api's
 * `loadApiConfigFromEnv` seam so no other module reads global env.
 *
 * The worker owns the credentials chat-api must NOT hold: the read-only KB, the
 * OpenRouter provider key, and the E2B key. None of these are ever placed into
 * E2B sandbox env (see `buildSandboxEnv`).
 */
export interface WorkerConfig {
	/** Writable mymemo_agent DB: runs, run_events, conversation_runtime, etc. */
	agentDatabaseUrl: string;
	/** Read-only KB DB: scoped document search/fetch only. */
	kbDatabaseUrl: string;
	/** OpenRouter Anthropic-compatible model traffic. Trusted-worker-only. */
	openrouter: {
		apiKey: string;
		baseUrl: string;
		defaultModel: string;
	};
	/** E2B API key for the untrusted filesystem/shell executor. */
	e2bApiKey: string;
	/** Conservative default run concurrency per worker task. */
	maxConcurrentRuns: number;
	/** How often an active run heartbeats its lease (ms). */
	heartbeatIntervalMs: number;
	/** Grace period to drain active runs on shutdown before forcing exit (ms). */
	shutdownTimeoutMs: number;
	/** pino log level. */
	logLevel: string;
	/** Port the health endpoint listens on. */
	port: number;
}

const DEFAULT_MAX_CONCURRENT_RUNS = 2;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_PORT = 8080;

/** Append `sslmode=require` unless TLS is disabled or the URL already sets it. */
function withSsl(url: string, enabled: boolean): string {
	if (!enabled || /[?&]sslmode=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}sslmode=require`;
}

/**
 * If the URL is passwordless (the platform-injected form) and a password is
 * provided, splice it in. Kept local to the worker rather than imported from
 * chat-api: the worker must not depend on chat-api internals.
 */
function withPassword(url: string, password: string | undefined): string {
	if (!password) return url;
	const m = /^([a-z]+:\/\/)([^@/]+)@(.*)$/i.exec(url);
	if (!m) return url;
	const [, scheme, userinfo, rest] = m;
	if (!scheme || !userinfo || rest === undefined) return url;
	if (userinfo.includes(":")) return url; // already has a password
	return `${scheme}${userinfo}:${encodeURIComponent(password)}@${rest}`;
}

/** Parse a positive-integer env override, or fall back to the default. */
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

/** Parse + validate the environment into a typed worker config. Pure. */
export function loadWorkerConfigFromEnv(env: Env): WorkerConfig {
	assert(env.AGENT_DATABASE_URL, "AGENT_DATABASE_URL is required");
	assert(env.KB_DATABASE_URL, "KB_DATABASE_URL is required");
	assert(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is required");
	assert(env.OPENROUTER_BASE_URL, "OPENROUTER_BASE_URL is required");
	assert(env.OPENROUTER_DEFAULT_MODEL, "OPENROUTER_DEFAULT_MODEL is required");
	assert(env.E2B_API_KEY, "E2B_API_KEY is required");

	const sslEnabled = env.DB_SSL !== "disable";

	return {
		// DB_PASSWORD is the writable agent role's password in the platform's
		// passwordless-URL form; the KB carries its own credential inline.
		agentDatabaseUrl: withSsl(
			withPassword(env.AGENT_DATABASE_URL, env.DB_PASSWORD),
			sslEnabled,
		),
		kbDatabaseUrl: withSsl(env.KB_DATABASE_URL, sslEnabled),
		openrouter: {
			apiKey: env.OPENROUTER_API_KEY,
			// Trailing slash stripped so `${base}/v1/messages` never doubles up.
			baseUrl: env.OPENROUTER_BASE_URL.replace(/\/+$/, ""),
			defaultModel: env.OPENROUTER_DEFAULT_MODEL,
		},
		e2bApiKey: env.E2B_API_KEY,
		maxConcurrentRuns: positiveIntOr(
			env.WORKER_MAX_CONCURRENT_RUNS,
			DEFAULT_MAX_CONCURRENT_RUNS,
			"WORKER_MAX_CONCURRENT_RUNS",
		),
		heartbeatIntervalMs: positiveIntOr(
			env.WORKER_HEARTBEAT_INTERVAL_MS,
			DEFAULT_HEARTBEAT_INTERVAL_MS,
			"WORKER_HEARTBEAT_INTERVAL_MS",
		),
		shutdownTimeoutMs: positiveIntOr(
			env.WORKER_SHUTDOWN_TIMEOUT_MS,
			DEFAULT_SHUTDOWN_TIMEOUT_MS,
			"WORKER_SHUTDOWN_TIMEOUT_MS",
		),
		logLevel: env.LOG_LEVEL || "info",
		port: positiveIntOr(env.PORT, DEFAULT_PORT, "PORT"),
	};
}
