import type { Hono } from "hono";
import type { GatewayConfig } from "../env";
import { proxyToAnthropic } from "./proxy";

/**
 * Register the LLM proxy as the catch-all. MUST be registered last (after the
 * document routes) because Hono matches in registration order and this matches
 * every path; see `server.ts`.
 */
export function registerLlmRoutes(app: Hono, config: GatewayConfig): void {
	// A trailing-slash base URL (`…//v1/messages`) still routes here and gets
	// normalized inside the proxy.
	app.all("*", (c) => proxyToAnthropic(c, config));
}
