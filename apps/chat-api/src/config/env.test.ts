import { describe, expect, it } from "bun:test";
import { type ApiConfig, loadApiConfigFromEnv } from "./env";

/**
 * Split-runtime env ownership (MYM-45). `chat-api` owns the writable agent DB
 * and the Statsig exposure config; the production `ApiConfig` must NOT require
 * or read the path-specific secrets — the Runtime's (OpenRouter, KB, E2B) or
 * the local-only Harness path's (`harness-env.ts`). These tests pin that boundary.
 */

/** A minimal env that loads cleanly. */
function baseEnv(): Record<string, string | undefined> {
	return {
		AGENT_DATABASE_URL: "postgresql://u:p@localhost:5432/mymemo_agent",
		ARTIFACT_BUCKET: "mymemo-agent-test-artifacts",
		AWS_REGION: "us-west-2",
		REDIS_URL: "rediss://default:secret@redis.internal:6379",
		STATSIG_SERVER_SECRET: "secret-statsig",
		DB_SSL: "disable",
	};
}

describe("loadApiConfigFromEnv — agent DB ownership", () => {
	it("refuses to boot without AGENT_DATABASE_URL", () => {
		const env = baseEnv();
		delete env.AGENT_DATABASE_URL;
		expect(() => loadApiConfigFromEnv(env)).toThrow(/AGENT_DATABASE_URL/);
	});

	it("reads the writable agent DB from AGENT_DATABASE_URL, not DATABASE_URL", () => {
		const env = baseEnv();
		// A stray DATABASE_URL (the gateway's KB var name) must be ignored.
		env.DATABASE_URL = "postgresql://kb:kb@localhost:5432/mymemo_kb";
		const config = loadApiConfigFromEnv(env);
		expect(config.databaseUrl).toContain("mymemo_agent");
		expect(config.databaseUrl).not.toContain("mymemo_kb");
	});
});

describe("loadApiConfigFromEnv — Downloadable artifact storage", () => {
	it("requires the private artifact bucket and its AWS region", () => {
		const missingBucket = baseEnv();
		delete missingBucket.ARTIFACT_BUCKET;
		expect(() => loadApiConfigFromEnv(missingBucket)).toThrow(
			/ARTIFACT_BUCKET/,
		);

		const missingRegion = baseEnv();
		delete missingRegion.AWS_REGION;
		expect(() => loadApiConfigFromEnv(missingRegion)).toThrow(/AWS_REGION/);
	});

	it("exposes the validated bucket and region to trusted chat-api composition", () => {
		const config = loadApiConfigFromEnv(baseEnv());
		expect(config.artifactBucket).toBe("mymemo-agent-test-artifacts");
		expect(config.artifactRegion).toBe("us-west-2");
	});
});

describe("production `ApiConfig` excludes path-specific secrets", () => {
	it("boots without any path-specific secret present", () => {
		const env = baseEnv();
		// None of these are set; chat-api must not require them.
		expect(env.OPENROUTER_API_KEY).toBeUndefined();
		expect(env.KB_DATABASE_URL).toBeUndefined();
		expect(env.E2B_API_KEY).toBeUndefined();
		expect(env.WORKER_E2B_TEMPLATE).toBeUndefined();
		expect(env.LLM_TOKEN_SECRET).toBeUndefined();
		expect(() => loadApiConfigFromEnv(env)).not.toThrow();
	});

	it("never surfaces path-specific secrets on the config object", () => {
		const env = baseEnv();
		env.OPENROUTER_API_KEY = "sk-or-should-be-ignored";
		env.OPENROUTER_BASE_URL = "https://openrouter.test";
		env.OPENROUTER_DEFAULT_MODEL = "anthropic/claude";
		env.KB_DATABASE_URL = "postgresql://kb:kb@localhost:5432/mymemo_kb";
		env.E2B_API_KEY = "e2b-should-be-ignored";
		env.WORKER_E2B_TEMPLATE = "template-should-be-ignored";
		env.LLM_TOKEN_SECRET = "llm-token-secret";
		env.GATEWAY_PUBLIC_URL = "https://gateway.test";
		const config = loadApiConfigFromEnv(env);
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain("sk-or-should-be-ignored");
		expect(serialized).not.toContain("openrouter.test");
		expect(serialized).not.toContain("mymemo_kb");
		expect(serialized).not.toContain("e2b-should-be-ignored");
		expect(serialized).not.toContain("template-should-be-ignored");
		expect(serialized).not.toContain("llm-token-secret");
		expect(serialized).not.toContain("gateway.test");
		// And there is no openrouter/kb field by name.
		expect(config as unknown as Record<string, unknown>).not.toHaveProperty(
			"openrouterApiKey",
		);
		expect(config as unknown as Record<string, unknown>).not.toHaveProperty(
			"kbDatabaseUrl",
		);
	});

	it("ignores AgentCore queue and SSM dispatch configuration", () => {
		const env = baseEnv();
		env.AGENTCORE_DISPATCH_QUEUE_URL =
			"https://sqs.us-west-2.amazonaws.com/123/dispatch";
		env.AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME = "/mymemo/dispatch/enabled";

		const serialized = JSON.stringify(loadApiConfigFromEnv(env));
		expect(serialized).not.toContain("sqs.us-west-2.amazonaws.com");
		expect(serialized).not.toContain("/mymemo/dispatch/enabled");
	});
});

describe("loadApiConfigFromEnv — Statsig exposure config", () => {
	it("always requires STATSIG_SERVER_SECRET", () => {
		const env = baseEnv();
		delete env.STATSIG_SERVER_SECRET;
		expect(() => loadApiConfigFromEnv(env)).toThrow(/STATSIG_SERVER_SECRET/);
		env.AGENT_EXPOSURE_BREAK_GLASS = "true";
		expect(() => loadApiConfigFromEnv(env)).toThrow(/STATSIG_SERVER_SECRET/);
	});

	it("carries the Statsig secret when configured normally", () => {
		const config = loadApiConfigFromEnv(baseEnv());
		expect(config.statsigServerSecret).toBe("secret-statsig");
	});
	it("ignores legacy prototype provider settings", () => {
		const env = baseEnv();
		env.SANDBOX_PROVIDER = "e2b";
		env.E2B_TEMPLATE = "legacy-template";
		env.LOCAL_SANDBOX_DAEMON_URL = "http://sandbox:8080";
		const config = loadApiConfigFromEnv(env);
		expect(config as unknown as Record<string, unknown>).not.toHaveProperty(
			"sandboxProvider",
		);
		expect(config as unknown as Record<string, unknown>).not.toHaveProperty(
			"e2bTemplate",
		);
	});

	it("returns a config typed as ApiConfig with the expected core fields", () => {
		const config: ApiConfig = loadApiConfigFromEnv(baseEnv());
		expect(config.databaseUrl).toContain("mymemo_agent");
	});
});

describe("loadApiConfigFromEnv — split-runtime core", () => {
	it("returns a config typed as ApiConfig with the expected core fields", () => {
		const config: ApiConfig = loadApiConfigFromEnv(baseEnv());
		expect(config.logLevel).toBe("info");
	});

	it("does not require GATEWAY_PUBLIC_URL", () => {
		const env = baseEnv();
		delete env.GATEWAY_PUBLIC_URL;
		const config = loadApiConfigFromEnv(env);
		expect(config.databaseUrl).toContain("mymemo_agent");
	});
});

describe("loadApiConfigFromEnv — required Live Stream Redis", () => {
	it("accepts only an authenticated TLS URL", () => {
		const env = baseEnv();
		expect(loadApiConfigFromEnv(env).redisUrl).toBe(
			"rediss://default:secret@redis.internal:6379",
		);
	});

	it("allows insecure loopback Redis only under the integration-test switch", () => {
		const env = baseEnv();
		env.REDIS_URL = "redis://127.0.0.1:6379";
		env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS = "true";
		expect(loadApiConfigFromEnv(env).redisUrl).toBe(env.REDIS_URL);
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
			expect(() => loadApiConfigFromEnv(env)).toThrow(/REDIS_URL/);
		}
	});
});
