import { describe, expect, it } from "bun:test";
import { loadWorkerConfigFromEnv } from "./env";

/**
 * Worker env ownership (MYM-47 / MYM-45 boundary). `agent-worker` owns the
 * writable agent DB, the read-only KB, the OpenRouter provider credentials, and
 * the E2B key. It must refuse to boot when any required setting is missing.
 */
function baseEnv(): Record<string, string | undefined> {
	return {
		AGENT_DATABASE_URL: "postgresql://u:p@localhost:5432/mymemo_agent",
		KB_DATABASE_URL: "postgresql://r:r@localhost:5432/mymemo_kb",
		OPENROUTER_API_KEY: "sk-or-test",
		OPENROUTER_BASE_URL: "https://openrouter.ai/api",
		OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4",
		E2B_API_KEY: "e2b-test",
		WORKER_E2B_TEMPLATE: "mymemo-agent-sandbox",
		DB_SSL: "disable",
	};
}

describe("loadWorkerConfigFromEnv — required settings", () => {
	const required = [
		"AGENT_DATABASE_URL",
		"KB_DATABASE_URL",
		"OPENROUTER_API_KEY",
		"OPENROUTER_BASE_URL",
		"OPENROUTER_DEFAULT_MODEL",
		"E2B_API_KEY",
		"WORKER_E2B_TEMPLATE",
	];

	it("loads cleanly with all required settings present", () => {
		expect(() => loadWorkerConfigFromEnv(baseEnv())).not.toThrow();
	});

	for (const key of required) {
		it(`refuses to boot without ${key}`, () => {
			const env = baseEnv();
			delete env[key];
			expect(() => loadWorkerConfigFromEnv(env)).toThrow(new RegExp(key));
		});
	}

	it("surfaces the two DB connections separately", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.agentDatabaseUrl).toContain("mymemo_agent");
		expect(config.kbDatabaseUrl).toContain("mymemo_kb");
	});

	it("surfaces the E2B template the worker provisions sandboxes from", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.e2bTemplate).toBe("mymemo-agent-sandbox");
	});

	it("surfaces the OpenRouter provider config", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.openrouter.apiKey).toBe("sk-or-test");
		expect(config.openrouter.baseUrl).toBe("https://openrouter.ai/api");
		expect(config.openrouter.defaultModel).toBe("anthropic/claude-sonnet-4");
	});
});

describe("loadWorkerConfigFromEnv — concurrency and intervals", () => {
	it("defaults to conservative concurrency", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.maxConcurrentRuns).toBe(2);
	});

	it("defaults heartbeat to 15s and a bounded shutdown grace", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.heartbeatIntervalMs).toBe(15_000);
		expect(config.shutdownTimeoutMs).toBeGreaterThan(0);
	});

	it("honors overrides for concurrency and intervals", () => {
		const env = baseEnv();
		env.WORKER_MAX_CONCURRENT_RUNS = "4";
		env.WORKER_DOCUMENT_SEARCH_MAX_RESULTS = "12";
		env.WORKER_HEARTBEAT_INTERVAL_MS = "10000";
		env.WORKER_SHUTDOWN_TIMEOUT_MS = "5000";
		const config = loadWorkerConfigFromEnv(env);
		expect(config.maxConcurrentRuns).toBe(4);
		expect(config.maxDocumentSearchResults).toBe(12);
		expect(config.heartbeatIntervalMs).toBe(10_000);
		expect(config.shutdownTimeoutMs).toBe(5_000);
	});

	it("rejects a non-positive concurrency override", () => {
		const env = baseEnv();
		env.WORKER_MAX_CONCURRENT_RUNS = "0";
		expect(() => loadWorkerConfigFromEnv(env)).toThrow(
			/WORKER_MAX_CONCURRENT_RUNS/,
		);
	});

	it("rejects a non-positive document search limit override", () => {
		const env = baseEnv();
		env.WORKER_DOCUMENT_SEARCH_MAX_RESULTS = "0";
		expect(() => loadWorkerConfigFromEnv(env)).toThrow(
			/WORKER_DOCUMENT_SEARCH_MAX_RESULTS/,
		);
	});
});

describe("loadWorkerConfigFromEnv — SDK execution limits", () => {
	it("defaults the sandbox, file, and Bash limits", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());

		expect(config.sandboxIdleMs).toBe(300_000);
		expect(config.fileLimits).toEqual({
			readMaxBytes: 65_536,
			readMaxLines: 2_000,
			grepMaxResults: 100,
			globMaxResults: 500,
			commandMaxOutputBytes: 65_536,
			commandTimeoutMs: 30_000,
		});
		expect(config.bashLimits).toEqual({
			systemMaxTimeoutMs: 120_000,
			maxStdoutBytes: 65_536,
			maxStderrBytes: 65_536,
		});
	});

	it("honors sandbox, file, and Bash limit overrides", () => {
		const env = baseEnv();
		env.WORKER_SANDBOX_IDLE_MS = "600000";
		env.WORKER_FILE_GREP_MAX_RESULTS = "25";
		env.WORKER_FILE_GLOB_MAX_RESULTS = "75";
		env.WORKER_FILE_READ_MAX_BYTES = "32768";
		env.WORKER_BASH_TIMEOUT_MS = "45000";
		env.WORKER_BASH_MAX_OUTPUT_BYTES = "8192";

		const config = loadWorkerConfigFromEnv(env);

		expect(config.sandboxIdleMs).toBe(600_000);
		expect(config.fileLimits).toMatchObject({
			grepMaxResults: 25,
			globMaxResults: 75,
			readMaxBytes: 32_768,
		});
		expect(config.bashLimits).toEqual({
			systemMaxTimeoutMs: 45_000,
			maxStdoutBytes: 8_192,
			maxStderrBytes: 8_192,
		});
	});
});

describe("loadWorkerConfigFromEnv — cleanup loop", () => {
	it("defaults the cleanup interval", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.cleanup.intervalMs).toBe(300_000);
	});

	it("honors the cleanup interval override", () => {
		const env = baseEnv();
		env.WORKER_CLEANUP_INTERVAL_MS = "120000";
		const config = loadWorkerConfigFromEnv(env);
		expect(config.cleanup.intervalMs).toBe(120_000);
	});

	it("rejects a non-positive cleanup interval override", () => {
		const env = baseEnv();
		env.WORKER_CLEANUP_INTERVAL_MS = "0";
		expect(() => loadWorkerConfigFromEnv(env)).toThrow(
			/WORKER_CLEANUP_INTERVAL_MS/,
		);
	});
});

describe("loadWorkerConfigFromEnv — LoadDocuments caps", () => {
	it("defaults the document-load caps", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.documentLoad.maxDocuments).toBe(10);
		expect(config.documentLoad.perDocumentMaxBytes).toBeGreaterThan(0);
		expect(config.documentLoad.perCallMaxBytes).toBeGreaterThanOrEqual(
			config.documentLoad.perDocumentMaxBytes,
		);
	});

	it("honors document-load cap overrides", () => {
		const env = baseEnv();
		env.WORKER_DOCUMENT_LOAD_MAX_DOCUMENTS = "3";
		env.WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES = "1000";
		env.WORKER_DOCUMENT_LOAD_PER_CALL_MAX_BYTES = "4000";
		const config = loadWorkerConfigFromEnv(env);
		expect(config.documentLoad.maxDocuments).toBe(3);
		expect(config.documentLoad.perDocumentMaxBytes).toBe(1_000);
		expect(config.documentLoad.perCallMaxBytes).toBe(4_000);
	});

	it("rejects a non-positive document-load byte cap override", () => {
		const env = baseEnv();
		env.WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES = "0";
		expect(() => loadWorkerConfigFromEnv(env)).toThrow(
			/WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES/,
		);
	});
});

describe("loadWorkerConfigFromEnv — optional Live Redis lane", () => {
	it("enables Live preview only for an authenticated TLS URL", () => {
		const env = baseEnv();
		env.REDIS_URL = "rediss://default:secret@redis.internal:6379";
		expect(loadWorkerConfigFromEnv(env).liveTextRedisUrl).toBe(env.REDIS_URL);
	});

	it("degrades missing, malformed, or insecure Redis configuration", () => {
		for (const redisUrl of [
			undefined,
			"not a URL",
			"redis://default:secret@redis.internal:6379",
			"rediss://redis.internal:6379",
		]) {
			const env = baseEnv();
			env.REDIS_URL = redisUrl;
			expect(() => loadWorkerConfigFromEnv(env)).not.toThrow();
			expect(loadWorkerConfigFromEnv(env).liveTextRedisUrl).toBeUndefined();
		}
	});
});
