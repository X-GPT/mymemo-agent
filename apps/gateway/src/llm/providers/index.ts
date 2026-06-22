import invariant from "tiny-invariant";
import type { GatewayConfig } from "../../env";
import { anthropicProvider } from "./anthropic";
import { openRouterProvider } from "./openrouter";
import type { LlmProvider } from "./types";

export type { LlmProvider } from "./types";

/**
 * Pick the LLM upstream provider from gateway config. Built once at route
 * registration and closed over by the proxy handler, so provider selection is a
 * single startup decision rather than a per-request branch.
 */
export function selectLlmProvider(config: GatewayConfig): LlmProvider {
	if (config.llmProvider === "openrouter") {
		// loadConfigFromEnv guarantees this is present when the provider is
		// openrouter; the invariant keeps the type narrow and fails loudly if a
		// hand-built config skips it.
		invariant(
			config.openRouter,
			"openRouter config is required when LLM_PROVIDER=openrouter",
		);
		return openRouterProvider(config.openRouter);
	}
	return anthropicProvider(config);
}
