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
	/** Every Runtime and Harness-path variable, planted so a leak would show. */
	const pathSpecific = Object.fromEntries(
		[
			"OPENROUTER_API_KEY",
			"OPENROUTER_BASE_URL",
			"OPENROUTER_DEFAULT_MODEL",
			"KB_DATABASE_URL",
			"E2B_API_KEY",
			"WORKER_E2B_TEMPLATE",
			"LLM_TOKEN_SECRET",
			"VERCEL_TOKEN",
			"VERCEL_TEAM_ID",
			"VERCEL_PROJECT_ID",
			"HARNESS_SANDBOX_TIMEOUT_MS",
			"HARNESS_SANDBOX_REGION",
		].map((name) => [name, `${name}-planted`]),
	);

	// The loader builds a literal with exactly these fields, so no planted value
	// can surface on it, and `baseEnv()` alone loads, so none is required.
	// Adding a field is a deliberate act that touches this list.
	it("boots without them and carries exactly the six production fields", () => {
		const keys = (env: Record<string, string | undefined>) =>
			Object.keys(loadApiConfigFromEnv(env)).sort();
		const production = [
			"artifactBucket",
			"artifactRegion",
			"databaseUrl",
			"logLevel",
			"redisUrl",
			"statsigServerSecret",
		];
		expect(keys(baseEnv())).toEqual(production);
		const planted = loadApiConfigFromEnv({ ...baseEnv(), ...pathSpecific });
		expect(Object.keys(planted).sort()).toEqual(production);
		expect(JSON.stringify(planted)).not.toContain("-planted");
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
