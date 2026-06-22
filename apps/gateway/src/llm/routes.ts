import type { Hono } from "hono";
import type { GatewayConfig } from "../env";
import { selectLlmProvider } from "./providers";
import { proxyLlm } from "./proxy";

/**
 * Register the LLM proxy as the catch-all. MUST be registered last (after the
 * document routes) because Hono matches in registration order and this matches
 * every path; see `server.ts`.
 */
export function registerLlmRoutes(app: Hono, config: GatewayConfig): void {
	// Provider selection is a single startup decision; the proxy handler closes
	// over it rather than re-resolving per request.
	const provider = selectLlmProvider(config);
	// A trailing-slash base URL (`…//v1/messages`) still routes here and gets
	// normalized inside the proxy.
	app.all("*", (c) => proxyLlm(c, config, provider));
}
