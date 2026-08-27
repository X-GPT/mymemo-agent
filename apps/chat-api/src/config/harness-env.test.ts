import { expect, it } from "bun:test";
import { loadHarnessConfigFromEnv } from "./harness-env";

const baseEnv = {
	VERCEL_TOKEN: "vercel-token",
	VERCEL_TEAM_ID: "team_1",
	VERCEL_PROJECT_ID: "prj_1",
	OPENROUTER_API_KEY: "sk-or-test",
};

it("applies the documented defaults", () => {
	expect(loadHarnessConfigFromEnv(baseEnv)).toEqual({
		vercel: { token: "vercel-token", teamId: "team_1", projectId: "prj_1" },
		openrouterApiKey: "sk-or-test",
		openrouterBaseUrl: "https://openrouter.ai/api",
		model: "anthropic/claude-sonnet-5",
		sandboxTimeoutMs: 600_000,
		sandboxRegion: "iad1",
	});
});

it("reads the overrides", () => {
	const config = loadHarnessConfigFromEnv({
		...baseEnv,
		OPENROUTER_BASE_URL: "https://openrouter.test/api",
		OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4",
		HARNESS_SANDBOX_TIMEOUT_MS: "120000",
		HARNESS_SANDBOX_REGION: "sfo1",
	});
	expect(config.openrouterBaseUrl).toBe("https://openrouter.test/api");
	expect(config.model).toBe("anthropic/claude-sonnet-4");
	expect(config.sandboxTimeoutMs).toBe(120_000);
	expect(config.sandboxRegion).toBe("sfo1");
});

it.each([
	"VERCEL_TOKEN",
	"VERCEL_TEAM_ID",
	"VERCEL_PROJECT_ID",
	"OPENROUTER_API_KEY",
])("requires %s", (name) => {
	expect(() =>
		loadHarnessConfigFromEnv({ ...baseEnv, [name]: undefined }),
	).toThrow(new RegExp(name));
});

it("rejects a malformed sandbox timeout", () => {
	expect(() =>
		loadHarnessConfigFromEnv({
			...baseEnv,
			HARNESS_SANDBOX_TIMEOUT_MS: "soon",
		}),
	).toThrow(/HARNESS_SANDBOX_TIMEOUT_MS/);
});
