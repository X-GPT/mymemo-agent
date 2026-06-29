import { describe, expect, it } from "bun:test";
import { type ApiConfig, loadApiConfigFromEnv } from "./env";

/**
 * Split-runtime env ownership (MYM-45). `chat-api` owns the writable agent DB
 * and the Statsig exposure config; it must NOT require or read the worker-only
 * secrets (OpenRouter, KB). These tests pin that boundary.
 */

/** A minimal env that loads cleanly: the local provider needs no E2B key. */
function baseEnv(): Record<string, string | undefined> {
	return {
		SANDBOX_PROVIDER: "local",
		LLM_TOKEN_SECRET: "test-secret",
		GATEWAY_PUBLIC_URL: "https://gateway.test",
		AGENT_DATABASE_URL: "postgresql://u:p@localhost:5432/mymemo_agent",
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

describe("loadApiConfigFromEnv — worker-secret boundary", () => {
	it("boots without any worker-only secret present", () => {
		const env = baseEnv();
		// None of these are set; chat-api must not require them.
		expect(env.OPENROUTER_API_KEY).toBeUndefined();
		expect(env.KB_DATABASE_URL).toBeUndefined();
		expect(() => loadApiConfigFromEnv(env)).not.toThrow();
	});

	it("never surfaces worker-only secrets on the config object", () => {
		const env = baseEnv();
		env.OPENROUTER_API_KEY = "sk-or-should-be-ignored";
		env.OPENROUTER_BASE_URL = "https://openrouter.test";
		env.OPENROUTER_DEFAULT_MODEL = "anthropic/claude";
		env.KB_DATABASE_URL = "postgresql://kb:kb@localhost:5432/mymemo_kb";
		const config = loadApiConfigFromEnv(env);
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain("sk-or-should-be-ignored");
		expect(serialized).not.toContain("openrouter.test");
		expect(serialized).not.toContain("mymemo_kb");
		// And there is no openrouter/kb field by name.
		expect(config as Record<string, unknown>).not.toHaveProperty(
			"openrouterApiKey",
		);
		expect(config as Record<string, unknown>).not.toHaveProperty(
			"kbDatabaseUrl",
		);
	});
});

describe("loadApiConfigFromEnv — Statsig exposure config", () => {
	it("requires STATSIG_SERVER_SECRET when break-glass is off", () => {
		const env = baseEnv();
		delete env.STATSIG_SERVER_SECRET;
		expect(() => loadApiConfigFromEnv(env)).toThrow(/STATSIG_SERVER_SECRET/);
	});

	it("allows boot without the Statsig secret under operator break-glass", () => {
		const env = baseEnv();
		delete env.STATSIG_SERVER_SECRET;
		env.AGENT_EXPOSURE_BREAK_GLASS = "true";
		const config = loadApiConfigFromEnv(env);
		expect(config.agentExposureBreakGlass).toBe(true);
		expect(config.statsigServerSecret).toBeUndefined();
	});

	it("carries the Statsig secret when configured normally", () => {
		const config = loadApiConfigFromEnv(baseEnv());
		expect(config.agentExposureBreakGlass).toBe(false);
		expect(config.statsigServerSecret).toBe("secret-statsig");
	});
});

describe("loadApiConfigFromEnv — prototype provider path unchanged", () => {
	it("still requires E2B_API_KEY when SANDBOX_PROVIDER=e2b", () => {
		const env = baseEnv();
		env.SANDBOX_PROVIDER = "e2b";
		delete env.E2B_API_KEY;
		expect(() => loadApiConfigFromEnv(env)).toThrow(/E2B_API_KEY/);
	});

	it("returns a config typed as ApiConfig with the expected core fields", () => {
		const config: ApiConfig = loadApiConfigFromEnv(baseEnv());
		expect(config.sandboxProvider).toBe("local");
		expect(config.gatewayPublicUrl).toBe("https://gateway.test");
	});
});
