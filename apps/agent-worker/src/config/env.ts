import { resolveLiveStreamRedisUrl } from "@mymemo/live-text";
import {
	type BashToolLimits,
	DEFAULT_BASH_TOOL_LIMITS,
} from "../bash-tool/bash-tool";
import type { FileToolLimits } from "../file-tools/file-tools";

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
	/**
	 * E2B template id/alias run sandboxes are created from. The custom template
	 * (apps/agent-worker/e2b-template/) ships the Grep/Glob runtime toolchain —
	 * `rg` installed (the stock `base` template lacks it), `python3` confirmed.
	 * Required so a misconfigured worker fails at boot, not per run.
	 */
	e2bTemplate: string;
	/** Private durable object store for successful-Run Downloadable artifacts. */
	artifact: {
		bucket: string;
		region: string;
	};
	/** Required authenticated TLS Redis secret for the Live Stream relay. */
	redisUrl: string;
	/** How long an unrenewed E2B sandbox stays active before idle-pausing. */
	sandboxIdleMs: number;
	/** Bounds for the model-facing workspace file tools. */
	fileLimits: FileToolLimits;
	/** Bounds for one model-facing Bash invocation. */
	bashLimits: BashToolLimits;
	/** Conservative default run concurrency per worker task. */
	maxConcurrentRuns: number;
	/** Per-call cap for model-facing document search results. */
	maxDocumentSearchResults: number;
	/** Per-page cap for model-facing document inventory results. */
	maxDocumentListResults: number;
	/** Caps for the model-facing LoadDocuments tool (documents-as-files). */
	documentLoad: {
		/** Most document ids one LoadDocuments call may materialize. */
		maxDocuments: number;
		/** Byte cap on a single cached document's content. */
		perDocumentMaxBytes: number;
		/** Byte cap on the summed content written by one LoadDocuments call. */
		perCallMaxBytes: number;
	};
	/** How often an active run heartbeats its lease (ms). */
	heartbeatIntervalMs: number;
	/** Grace period to drain active runs on shutdown before forcing exit (ms). */
	shutdownTimeoutMs: number;
	/** Worker-embedded orphan/deleted-conversation cleanup loop (Task 8.1). */
	cleanup: {
		/** How often the single-flighted cleanup pass is attempted (ms). */
		intervalMs: number;
	};
	/** pino log level. */
	logLevel: string;
	/** Port the health endpoint listens on. */
	port: number;
}

const DEFAULT_MAX_CONCURRENT_RUNS = 2;
const DEFAULT_SANDBOX_IDLE_MS = 300_000;
const DEFAULT_FILE_READ_MAX_BYTES = 65_536;
const DEFAULT_FILE_READ_MAX_LINES = 2_000;
const DEFAULT_FILE_GREP_MAX_RESULTS = 100;
const DEFAULT_FILE_GLOB_MAX_RESULTS = 500;
const DEFAULT_FILE_COMMAND_MAX_OUTPUT_BYTES = 65_536;
const DEFAULT_FILE_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_DOCUMENT_SEARCH_MAX_RESULTS = 8;
const DEFAULT_DOCUMENT_LIST_MAX_RESULTS = 20;
const DEFAULT_DOCUMENT_LOAD_MAX_DOCUMENTS = 10;
// The KB fetch already clips content at 50k chars; these byte caps are the
// tool-side backstop so a heavy multibyte document cannot balloon on disk.
const DEFAULT_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES = 262_144;
const DEFAULT_DOCUMENT_LOAD_PER_CALL_MAX_BYTES = 1_048_576;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_PORT = 8080;

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
	assert(env.WORKER_E2B_TEMPLATE, "WORKER_E2B_TEMPLATE is required");
	assert(env.ARTIFACT_BUCKET, "ARTIFACT_BUCKET is required");
	assert(env.AWS_REGION, "AWS_REGION is required");
	const redisUrl = resolveLiveStreamRedisUrl(env.REDIS_URL, {
		allowInsecureLoopback:
			env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS === "true",
	});

	const sslEnabled = env.DB_SSL !== "disable";
	const bashMaxOutputBytes = positiveIntOr(
		env.WORKER_BASH_MAX_OUTPUT_BYTES,
		DEFAULT_BASH_TOOL_LIMITS.maxStdoutBytes,
		"WORKER_BASH_MAX_OUTPUT_BYTES",
	);

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
		e2bTemplate: env.WORKER_E2B_TEMPLATE,
		artifact: {
			bucket: env.ARTIFACT_BUCKET,
			region: env.AWS_REGION,
		},
		redisUrl,
		sandboxIdleMs: positiveIntOr(
			env.WORKER_SANDBOX_IDLE_MS,
			DEFAULT_SANDBOX_IDLE_MS,
			"WORKER_SANDBOX_IDLE_MS",
		),
		fileLimits: {
			readMaxBytes: positiveIntOr(
				env.WORKER_FILE_READ_MAX_BYTES,
				DEFAULT_FILE_READ_MAX_BYTES,
				"WORKER_FILE_READ_MAX_BYTES",
			),
			readMaxLines: DEFAULT_FILE_READ_MAX_LINES,
			grepMaxResults: positiveIntOr(
				env.WORKER_FILE_GREP_MAX_RESULTS,
				DEFAULT_FILE_GREP_MAX_RESULTS,
				"WORKER_FILE_GREP_MAX_RESULTS",
			),
			globMaxResults: positiveIntOr(
				env.WORKER_FILE_GLOB_MAX_RESULTS,
				DEFAULT_FILE_GLOB_MAX_RESULTS,
				"WORKER_FILE_GLOB_MAX_RESULTS",
			),
			commandMaxOutputBytes: DEFAULT_FILE_COMMAND_MAX_OUTPUT_BYTES,
			commandTimeoutMs: DEFAULT_FILE_COMMAND_TIMEOUT_MS,
		},
		bashLimits: {
			systemMaxTimeoutMs: positiveIntOr(
				env.WORKER_BASH_TIMEOUT_MS,
				DEFAULT_BASH_TOOL_LIMITS.systemMaxTimeoutMs,
				"WORKER_BASH_TIMEOUT_MS",
			),
			maxStdoutBytes: bashMaxOutputBytes,
			maxStderrBytes: bashMaxOutputBytes,
		},
		maxConcurrentRuns: positiveIntOr(
			env.WORKER_MAX_CONCURRENT_RUNS,
			DEFAULT_MAX_CONCURRENT_RUNS,
			"WORKER_MAX_CONCURRENT_RUNS",
		),
		maxDocumentSearchResults: positiveIntOr(
			env.WORKER_DOCUMENT_SEARCH_MAX_RESULTS,
			DEFAULT_DOCUMENT_SEARCH_MAX_RESULTS,
			"WORKER_DOCUMENT_SEARCH_MAX_RESULTS",
		),
		maxDocumentListResults: positiveIntOr(
			env.WORKER_DOCUMENT_LIST_MAX_RESULTS,
			DEFAULT_DOCUMENT_LIST_MAX_RESULTS,
			"WORKER_DOCUMENT_LIST_MAX_RESULTS",
		),
		documentLoad: {
			maxDocuments: positiveIntOr(
				env.WORKER_DOCUMENT_LOAD_MAX_DOCUMENTS,
				DEFAULT_DOCUMENT_LOAD_MAX_DOCUMENTS,
				"WORKER_DOCUMENT_LOAD_MAX_DOCUMENTS",
			),
			perDocumentMaxBytes: positiveIntOr(
				env.WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES,
				DEFAULT_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES,
				"WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES",
			),
			perCallMaxBytes: positiveIntOr(
				env.WORKER_DOCUMENT_LOAD_PER_CALL_MAX_BYTES,
				DEFAULT_DOCUMENT_LOAD_PER_CALL_MAX_BYTES,
				"WORKER_DOCUMENT_LOAD_PER_CALL_MAX_BYTES",
			),
		},
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
		cleanup: {
			intervalMs: positiveIntOr(
				env.WORKER_CLEANUP_INTERVAL_MS,
				DEFAULT_CLEANUP_INTERVAL_MS,
				"WORKER_CLEANUP_INTERVAL_MS",
			),
		},
		logLevel: env.LOG_LEVEL || "info",
		port: positiveIntOr(env.PORT, DEFAULT_PORT, "PORT"),
	};
}
