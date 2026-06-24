import type { OpenRouterConfig } from "../../env";
import type { LlmProvider } from "./types";

// OpenRouter exposes an Anthropic-compatible Messages endpoint, so the Claude
// SDK's `/v1/messages` path forwards through unchanged. `count_tokens` is NOT
// part of that compatibility surface — it fails closed here (a clear 404) rather
// than being forwarded and erroring opaquely upstream. This is the explicit
// Claude-SDK compatibility gate: only the proven-compatible path is forwarded.
const OPENROUTER_PATHS = new Set(["/v1/messages"]);

/**
 * OpenRouter upstream. The gateway-only `apiKey` is injected as a bearer token on
 * the upstream request only; the sandbox's own bearer token was already consumed
 * by token verification and is never forwarded. Optional attribution headers
 * (`HTTP-Referer` / `X-Title`) are OpenRouter's mechanism for app identification.
 */
export function openRouterProvider(config: OpenRouterConfig): LlmProvider {
	return {
		name: "openrouter",
		supportsPath: (path) => OPENROUTER_PATHS.has(path),
		upstreamUrl: (path, search) => `${config.baseUrl}${path}${search}`,
		authorizeUpstream: (headers) => {
			// Bearer auth replaces Anthropic's x-api-key.
			headers.set("authorization", `Bearer ${config.apiKey}`);
			if (config.httpReferer) headers.set("http-referer", config.httpReferer);
			if (config.appTitle) headers.set("x-title", config.appTitle);
		},
	};
}
