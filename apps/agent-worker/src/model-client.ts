import type { WorkerConfig } from "./config/env";

/**
 * Model client configuration for the Claude Agent SDK, built from the worker's
 * validated OpenRouter settings (ADR-0003: direct OpenRouter, Anthropic-
 * compatible). The SDK integration (Task 7.2) passes `env` to the spawned query
 * process and `model` as the query option — both stay inside the trusted
 * Fargate worker. Nothing here may ever flow into `buildSandboxEnv`: the
 * sandbox reaches the model only through tool results, never with a credential.
 */
export interface ModelClientConfig {
	/** Env for the SDK's model process. Holds the provider credential. */
	env: {
		ANTHROPIC_BASE_URL: string;
		ANTHROPIC_AUTH_TOKEN: string;
		ANTHROPIC_API_KEY: "";
	};
	/** The one allowed default model. v1 policy: no allowlist, no fallback. */
	model: string;
}

/**
 * Build the trusted-worker model client config. Pure. The same shape serves
 * the direct-Anthropic contingency (ADR-0003): flipping OPENROUTER_BASE_URL /
 * OPENROUTER_API_KEY to first-party values needs no code change, because
 * Anthropic also accepts Bearer auth via ANTHROPIC_AUTH_TOKEN.
 */
export function buildModelClientConfig(
	openrouter: WorkerConfig["openrouter"],
): ModelClientConfig {
	return {
		env: {
			ANTHROPIC_BASE_URL: openrouter.baseUrl,
			// Sent as a Bearer header by the SDK; the provider key never takes
			// any other form and never leaves this process.
			ANTHROPIC_AUTH_TOKEN: openrouter.apiKey,
			// Pinned empty so the SDK cannot fall back to an ambient
			// first-party key present in the task environment.
			ANTHROPIC_API_KEY: "",
		},
		model: openrouter.defaultModel,
	};
}
