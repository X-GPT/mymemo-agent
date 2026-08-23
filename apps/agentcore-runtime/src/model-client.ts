import type { WorkerConfig } from "./worker-config";

/** Provider credentials stay in AgentCore Runtime and never enter E2B. */
export interface ModelClientConfig {
	env: {
		ANTHROPIC_BASE_URL: string;
		ANTHROPIC_AUTH_TOKEN: string;
		ANTHROPIC_API_KEY: "";
	};
	/** The one allowed default model. v1 policy: no allowlist, no fallback. */
	model: string;
}

/** Also supports direct Anthropic through configuration alone (ADR-0003). */
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
