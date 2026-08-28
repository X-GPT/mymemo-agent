import { expect, it } from "bun:test";
import { loadHarnessConfigFromEnv } from "./harness-env";

/** The local-only Harness path's own secrets; `env.test.ts` proves `ApiConfig` reads none of them. */
function baseEnv(): Record<string, string | undefined> {
	return {
		VERCEL_TOKEN: "vercel-token",
		VERCEL_TEAM_ID: "team_1",
		VERCEL_PROJECT_ID: "prj_1",
		OPENROUTER_API_KEY: "sk-or-1",
		E2B_API_KEY: "e2b-key",
	};
}

it("requires E2B_API_KEY and defaults the Workspace template", () => {
	const env = baseEnv();
	delete env.E2B_API_KEY;
	expect(() => loadHarnessConfigFromEnv(env)).toThrow(/E2B_API_KEY/);

	const config = loadHarnessConfigFromEnv(baseEnv());
	expect(config.E2B_API_KEY).toBe("e2b-key");
	expect(config.WORKER_E2B_TEMPLATE).toBe("mymemo-agent-sandbox");
	expect(
		loadHarnessConfigFromEnv({ ...baseEnv(), WORKER_E2B_TEMPLATE: "custom" })
			.WORKER_E2B_TEMPLATE,
	).toBe("custom");
});
