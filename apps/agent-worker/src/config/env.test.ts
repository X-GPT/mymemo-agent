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
		REDIS_URL: "rediss://default:secret@redis.internal:6379",
		E2B_API_KEY: "e2b-test",
		WORKER_E2B_TEMPLATE: "mymemo-agent-sandbox",
		ARTIFACT_BUCKET: "private-artifacts",
		AWS_REGION: "us-west-2",
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
		"ARTIFACT_BUCKET",
		"AWS_REGION",
		"REDIS_URL",
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

	it("surfaces the private artifact bucket configuration", () => {
		expect(loadWorkerConfigFromEnv(baseEnv()).artifact).toEqual({
			bucket: "private-artifacts",
			region: "us-west-2",
		});
	});

	it("surfaces the OpenRouter provider config", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.openrouter.apiKey).toBe("sk-or-test");
		expect(config.openrouter.baseUrl).toBe("https://openrouter.ai/api");
		expect(config.openrouter.defaultModel).toBe("anthropic/claude-sonnet-4");
	});
});

describe("loadWorkerConfigFromEnv — serving intervals", () => {
	it("defaults heartbeat to 15s and a bounded shutdown grace", () => {
		const config = loadWorkerConfigFromEnv(baseEnv());
		expect(config.heartbeatIntervalMs).toBe(15_000);
		expect(config.shutdownTimeoutMs).toBeGreaterThan(0);
	});

	it("honors heartbeat and shutdown overrides", () => {
		const env = baseEnv();
		env.WORKER_HEARTBEAT_INTERVAL_MS = "10000";
		env.WORKER_SHUTDOWN_TIMEOUT_MS = "5000";
		const config = loadWorkerConfigFromEnv(env);
		expect(config.heartbeatIntervalMs).toBe(10_000);
		expect(config.shutdownTimeoutMs).toBe(5_000);
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
			commandMaxOutputBytes: 65_536,
			commandTimeoutMs: 30_000,
		});
		expect(config.bashLimits).toEqual({
			systemMaxTimeoutMs: 120_000,
			maxStdoutBytes: 65_536,
			maxStderrBytes: 65_536,
		});
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
});

describe("loadWorkerConfigFromEnv — ListDocuments cap", () => {
	it("defaults the document-list page cap to twenty", () => {
		expect(loadWorkerConfigFromEnv(baseEnv()).maxDocumentListResults).toBe(20);
	});
});

describe("loadWorkerConfigFromEnv — required Live Stream Redis", () => {
	it("accepts only an authenticated TLS URL", () => {
		const env = baseEnv();
		expect(loadWorkerConfigFromEnv(env).redisUrl).toBe(
			"rediss://default:secret@redis.internal:6379",
		);
	});

	it("allows insecure loopback Redis only under the integration-test switch", () => {
		const env = baseEnv();
		env.REDIS_URL = "redis://127.0.0.1:6379";
		env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS = "true";
		expect(loadWorkerConfigFromEnv(env).redisUrl).toBe(env.REDIS_URL);
	});

	it("refuses to boot with missing, malformed, or insecure Redis configuration", () => {
		for (const redisUrl of [
			undefined,
			"not a URL",
			"redis://default:secret@redis.internal:6379",
			"rediss://redis.internal:6379",
		]) {
			const env = baseEnv();
			env.REDIS_URL = redisUrl;
			expect(() => loadWorkerConfigFromEnv(env)).toThrow(/REDIS_URL/);
		}
	});
});
