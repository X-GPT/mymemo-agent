import type { GatewayConfig } from "../../env";
import type { LlmProvider } from "./types";

// Anthropic Messages endpoints the proxy will forward. count_tokens is part of
// Anthropic's compatibility surface (and used by the Claude SDK), so it is
// allowed here.
const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

/**
 * The historical default upstream: talk to the Anthropic Messages API directly,
 * authenticating with the real `x-api-key`. This preserves the exact behavior the
 * gateway had before provider selection existed.
 */
export function anthropicProvider(config: GatewayConfig): LlmProvider {
	return {
		name: "anthropic",
		supportsPath: (path) => ANTHROPIC_PATHS.has(path),
		upstreamUrl: (path, search) => `${config.upstreamBaseUrl}${path}${search}`,
		authorizeUpstream: (headers) =>
			headers.set("x-api-key", config.anthropicApiKey),
	};
}
