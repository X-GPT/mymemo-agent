import { describe, expect, it } from "bun:test";
import { buildModelClientConfig } from "./model-client";

/**
 * Task 7.1 (ADR-0003): model headers/credentials are injected only in the
 * trusted Runtime. The model client config is derived from the Runtime's
 * validated OpenRouter settings and is what the Claude Agent SDK integration
 * (Task 7.2) hands to `query()` — it never leaves the Runtime process.
 */
const openrouter = {
	apiKey: "sk-or-secret",
	baseUrl: "https://openrouter.ai/api",
	defaultModel: "anthropic/claude-sonnet-4",
};

describe("buildModelClientConfig — trusted Runtime model path", () => {
	it("points the SDK at OpenRouter's Anthropic-compatible endpoint", () => {
		const config = buildModelClientConfig(openrouter);
		expect(config.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
	});

	it("injects the OpenRouter key as the Bearer auth token", () => {
		const config = buildModelClientConfig(openrouter);
		expect(config.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-secret");
	});

	it("shields against an ambient first-party Anthropic key", () => {
		// The design doc pins ANTHROPIC_API_KEY="" so the SDK can never fall
		// back to a first-party key that happens to be in the task environment.
		const config = buildModelClientConfig(openrouter);
		expect(config.env.ANTHROPIC_API_KEY).toBe("");
	});

	it("carries the one allowed default model (v1: no fallback)", () => {
		const config = buildModelClientConfig(openrouter);
		expect(config.model).toBe("anthropic/claude-sonnet-4");
	});

	it("stays valid for the direct-Anthropic contingency via env flip", () => {
		// ADR-0003: a failed OpenRouter smoke test is fixed by flipping the
		// base URL + key values, not by a code change. Same shape must hold.
		const config = buildModelClientConfig({
			apiKey: "sk-ant-first-party",
			baseUrl: "https://api.anthropic.com",
			defaultModel: "claude-sonnet-4-5",
		});
		expect(config.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
		expect(config.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-first-party");
		expect(config.model).toBe("claude-sonnet-4-5");
	});
});
