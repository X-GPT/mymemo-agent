import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";
import { resolveLiveStreamRedisUrl } from "@mymemo/live-text";
import {
	type BashToolLimits,
	DEFAULT_BASH_TOOL_LIMITS,
} from "../bash-tool/bash-tool";
import type { FileToolLimits } from "../file-tools/file-tools";

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

/** Trusted credentials stay in AgentCore Runtime and never enter E2B. */
export interface WorkerConfig {
	agentDatabaseUrl: string;
	kbDatabaseUrl: string;
	openrouter: {
		apiKey: string;
		baseUrl: string;
		defaultModel: string;
	};
	e2bApiKey: string;
	e2bTemplate: string;
	artifact: {
		bucket: string;
		region: string;
	};
	redisUrl: string;
	sandboxIdleMs: number;
	fileLimits: FileToolLimits;
	bashLimits: BashToolLimits;
	maxDocumentSearchResults: number;
	maxDocumentListResults: number;
	documentLoad: {
		maxDocuments: number;
		perDocumentMaxBytes: number;
		perCallMaxBytes: number;
	};
	heartbeatIntervalMs: number;
	shutdownTimeoutMs: number;
	logLevel: string;
	port: number;
}

const DEFAULT_SANDBOX_IDLE_MS = 300_000;
const DEFAULT_FILE_READ_MAX_BYTES = 65_536;
const DEFAULT_FILE_READ_MAX_LINES = 2_000;
const DEFAULT_FILE_GREP_MAX_RESULTS = 100;
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
const DEFAULT_PORT = 8080;

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

	return {
		// DB_PASSWORD is the writable agent role's password in the platform's
		// passwordless-URL form; the KB carries its own credential inline.
		agentDatabaseUrl: resolveDatabaseUrl(
			env.AGENT_DATABASE_URL,
			env.DB_PASSWORD,
			env.DB_SSL,
		),
		kbDatabaseUrl: resolveDatabaseUrl(
			env.KB_DATABASE_URL,
			undefined,
			env.DB_SSL,
		),
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
		sandboxIdleMs: DEFAULT_SANDBOX_IDLE_MS,
		fileLimits: {
			readMaxBytes: DEFAULT_FILE_READ_MAX_BYTES,
			readMaxLines: DEFAULT_FILE_READ_MAX_LINES,
			grepMaxResults: DEFAULT_FILE_GREP_MAX_RESULTS,
			commandMaxOutputBytes: DEFAULT_FILE_COMMAND_MAX_OUTPUT_BYTES,
			commandTimeoutMs: DEFAULT_FILE_COMMAND_TIMEOUT_MS,
		},
		bashLimits: { ...DEFAULT_BASH_TOOL_LIMITS },
		maxDocumentSearchResults: DEFAULT_DOCUMENT_SEARCH_MAX_RESULTS,
		maxDocumentListResults: DEFAULT_DOCUMENT_LIST_MAX_RESULTS,
		documentLoad: {
			maxDocuments: DEFAULT_DOCUMENT_LOAD_MAX_DOCUMENTS,
			perDocumentMaxBytes: DEFAULT_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES,
			perCallMaxBytes: DEFAULT_DOCUMENT_LOAD_PER_CALL_MAX_BYTES,
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
		logLevel: env.LOG_LEVEL || "info",
		port: positiveIntOr(env.PORT, DEFAULT_PORT, "PORT"),
	};
}
