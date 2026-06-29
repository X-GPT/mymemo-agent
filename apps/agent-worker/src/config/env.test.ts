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
		env.WORKER_HEARTBEAT_INTERVAL_MS = "10000";
		env.WORKER_SHUTDOWN_TIMEOUT_MS = "5000";
		const config = loadWorkerConfigFromEnv(env);
		expect(config.maxConcurrentRuns).toBe(4);
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
});
