import { describe, expect, it } from "bun:test";
import { loadWorkerConfigFromEnv } from "./config/env";
import { buildSandboxEnv } from "./sandbox-env";

const binding = {
	userId: "member-1",
	conversationId: "conv-1",
	runId: "run-1",
	sandboxId: "sbx-1",
};

describe("buildSandboxEnv — credential boundary", () => {
	it("includes only per-run executor metadata", () => {
		expect(buildSandboxEnv(binding)).toEqual({
			MYMEMO_USER_ID: "member-1",
			MYMEMO_CONVERSATION_ID: "conv-1",
			MYMEMO_RUN_ID: "run-1",
			MYMEMO_SANDBOX_ID: "sbx-1",
			MYMEMO_RUNTIME: "split-fargate-e2b",
		});
	});

	it("carries no provider or KB secret even when the worker holds them", () => {
		// The worker config holds OpenRouter/KB/E2B secrets...
		const config = loadWorkerConfigFromEnv({
			AGENT_DATABASE_URL: "postgresql://u:p@localhost:5432/mymemo_agent",
			KB_DATABASE_URL: "postgresql://r:r@localhost:5432/mymemo_kb",
			OPENROUTER_API_KEY: "sk-or-secret",
			OPENROUTER_BASE_URL: "https://openrouter.ai/api",
			OPENROUTER_DEFAULT_MODEL: "anthropic/claude",
			E2B_API_KEY: "e2b-secret",
			DB_SSL: "disable",
		});
		// ...but buildSandboxEnv's signature only accepts the binding, so secrets
		// cannot structurally reach the sandbox env. Assert the values are absent.
		const env = buildSandboxEnv(binding);
		const serialized = JSON.stringify(env);
		expect(serialized).not.toContain(config.openrouter.apiKey);
		expect(serialized).not.toContain("mymemo_kb");
		expect(serialized).not.toContain(config.e2bApiKey);
		for (const forbidden of [
			"OPENROUTER_API_KEY",
			"KB_DATABASE_URL",
			"AGENT_DATABASE_URL",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"E2B_API_KEY",
		]) {
			expect(env as Record<string, unknown>).not.toHaveProperty(forbidden);
		}
	});
});
