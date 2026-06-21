import { Hono } from "hono";
import type { Db } from "./db/client";
import { registerDocumentRoutes } from "./documents/routes";
import type { GatewayConfig } from "./env";
import { registerLlmRoutes } from "./llm/routes";

/**
 * Gateway — the single trusted control plane for sandboxed agents. It does two
 * jobs that used to be two services:
 *
 *   1. LLM proxy (`llm/`). The Claude binary points ANTHROPIC_BASE_URL here and
 *      authenticates with a short-lived bearer token; we inject the real
 *      `x-api-key` and proxy only the Anthropic Messages endpoints.
 *
 *   2. Document reader (`documents/`). The `mymemo-docs` CLI points here with the
 *      same token; we read the MyMemo knowledge base (Postgres) and ENFORCE the
 *      turn's signed scope server-side, so a prompt-injected agent cannot widen
 *      it.
 *
 * Both families verify the token through the one shared seam in `auth/` (see
 * `auth/bearer.ts`), each passing its own required audience, so a token minted
 * for one family cannot be replayed against the other.
 *
 * Config is injected, not read from global env, so the app is a pure function of
 * (config, db) — tests construct it explicitly and there is no module-load
 * coupling to mutable process state.
 *
 * Tradeoff of the merge: this one process now holds BOTH ANTHROPIC_API_KEY and
 * DATABASE_URL and has a single egress identity reaching both Anthropic and the
 * KB Postgres — a wider blast radius than two separate services.
 */

/**
 * Build the gateway app from injected config + db. Pure: config in, app out.
 * The only place the environment is read is the entrypoint (`index.ts`).
 */
export function createGateway(config: GatewayConfig, db: Db): Hono {
	const app = new Hono();

	// ── Route registration order is correctness-critical ──
	// Hono matches in registration order. The LLM proxy is a catch-all
	// (`app.all("*")`), so /health and the document routes MUST be registered
	// first; otherwise /v1/documents/* would fall through to the Anthropic proxy
	// and 404 on its path allowlist.

	// 1. Health — GET and HEAD so load-balancer / k8s probes (which often use
	//    HEAD) don't fall through to the token-gated handlers and 401.
	app.on(["GET", "HEAD"], "/health", (c) => c.json({ status: "ok" }));

	// 2. Document reader — registered before the catch-all.
	registerDocumentRoutes(app, config, db);

	// 3. LLM proxy — catch-all, registered LAST.
	registerLlmRoutes(app, config);

	return app;
}
