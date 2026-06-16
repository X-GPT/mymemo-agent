import {
	type LlmTokenClaims,
	type TokenAudience,
	verifyLlmToken,
} from "@mymemo/llm-token";
import { type Context, Hono } from "hono";
import type { GatewayConfig } from "./config";
import type { Db } from "./db";
import {
	documentInCollection,
	fetchDocument,
	resolveDocumentId,
	searchPassages,
} from "./queries";

/**
 * Gateway — the single trusted control plane for sandboxed agents. It does two
 * jobs that used to be two services:
 *
 *   1. LLM proxy. Sandboxed agents point the Claude binary at this service via
 *      ANTHROPIC_BASE_URL and authenticate with a short-lived bearer token. The
 *      agent holds no provider key: we validate the token, inject the real
 *      `x-api-key`, and stream the upstream response back. Scope is narrow — only
 *      the Anthropic Messages endpoints are proxied and only an allowlist of
 *      request headers is forwarded, so a leaked token cannot reach
 *      files/batches/admin endpoints and no client headers leak upstream.
 *
 *   2. Document reader. The `mymemo-docs` CLI points at this same service via
 *      MYMEMO_DOC_GATEWAY_URL with the same token. We read the MyMemo knowledge
 *      base (Postgres) directly and ENFORCE the turn's signed scope server-side,
 *      so a prompt-injected agent cannot widen it. Search is FTS-only.
 *
 * Both code paths verify the token with the same verifyLlmToken +
 * config.llmTokenSecret (see `bearerClaims`), but each passes its own required
 * audience: the document routes accept only `aud: "documents"` tokens and the
 * LLM proxy accepts only `aud: "llm"`, so a token minted for one family cannot
 * be replayed against the other. Route registration order is
 * correctness-critical: Hono matches in registration order and the LLM proxy is
 * a catch-all, so the document routes MUST be registered before it (see below).
 *
 * Config is injected, not read from global env, so the app is a pure function of
 * (config, db) — tests construct it explicitly and there is no module-load
 * coupling to mutable process state.
 *
 * Tradeoff of the merge: this one process now holds BOTH ANTHROPIC_API_KEY and
 * DATABASE_URL and has a single egress identity reaching both Anthropic and the
 * KB Postgres — a wider blast radius than two separate services.
 */

// Paths the LLM proxy will forward (after slash-normalization). Everything else
// 404s even with a valid token.
const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

// The only request headers forwarded upstream. Authorization is replaced by
// x-api-key; everything else (host, content-length, accept-encoding, cookie, …)
// is dropped so fetch controls compression and nothing leaks to Anthropic.
const FORWARD_REQUEST_HEADERS = [
	"anthropic-version",
	"anthropic-beta",
	"content-type",
	"accept",
	"x-claude-code-session-id",
];

// Response headers fetch already decoded for us; forwarding them would mislead
// the client into decompressing again or mismatching the streamed length.
const RESPONSE_DROP_HEADERS = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
]);

const SEARCH_LIMIT = 8;

// Single token-verify helper shared by both route families. Each family passes
// its own audience so a token minted for the other family fails closed here:
// an `llm` token cannot reach the document routes and a `documents` token
// cannot reach the LLM proxy.
function bearerClaims(
	c: Context,
	secret: string,
	audience: TokenAudience,
): LlmTokenClaims | null {
	const auth = c.req.header("authorization")?.trim() ?? "";
	const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? "";
	return verifyLlmToken(token, secret, audience);
}

function unauthorized(c: Context) {
	return c.json({ error: "invalid or expired token" }, 401);
}

function forbidden(c: Context, message: string) {
	return c.json({ error: message }, 403);
}

/**
 * Fail closed: the gateway is the trust boundary and must not depend on the
 * minter always setting a scope. A token whose scope is absent or unknown is
 * rejected rather than falling through to global access.
 */
function isKnownScope(
	scope: LlmTokenClaims["scope"],
): scope is "global" | "collection" | "document" {
	return scope === "global" || scope === "collection" || scope === "document";
}

/**
 * Fail closed on the identity/scope ids too: the workspace pin and scope
 * narrowing are only safe if these are non-empty. Returns an error message to
 * forbid on, or null when the claims are usable.
 */
function scopeError(claims: LlmTokenClaims): string | null {
	if (!claims.userId) return "missing user";
	if (claims.scope === "collection" && !claims.collectionId)
		return "missing collection";
	if (claims.scope === "document" && !claims.summaryId)
		return "missing document";
	return null;
}

/**
 * Shared guard for the document routes: verify the bearer token for the
 * "documents" audience and fail closed on an unknown scope or empty
 * identity/scope ids. Returns the usable claims, or a Response to return as-is.
 * Both /v1/documents/* routes share this contract, so the enforcement lives in
 * one place and the two routes cannot drift apart.
 */
function requireDocumentClaims(
	c: Context,
	secret: string,
): LlmTokenClaims | Response {
	const claims = bearerClaims(c, secret, "documents");
	if (!claims) return unauthorized(c);
	if (!isKnownScope(claims.scope)) return forbidden(c, "unknown scope");
	const bad = scopeError(claims);
	if (bad) return forbidden(c, bad);
	return claims;
}

/**
 * Build the gateway app from injected config + db. Pure: config in, app out.
 * The only place the environment is read is the entrypoint (`index.ts`).
 */
export function createGateway(config: GatewayConfig, db: Db): Hono {
	const app = new Hono();

	// ── Route registration order is correctness-critical ──
	// Hono matches in registration order. The LLM proxy below is a catch-all
	// (`app.all("*")`), so /health and the document routes MUST be registered
	// first; otherwise /v1/documents/* would fall through to the Anthropic proxy
	// and 404 on its path allowlist.

	// 1. Health — GET and HEAD so load-balancer / k8s probes (which often use
	//    HEAD) don't fall through to the token-gated handlers and 401.
	app.on(["GET", "HEAD"], "/health", (c) => c.json({ status: "ok" }));

	// 2. Document reader. Registered before the catch-all so /v1/documents/* is
	//    handled here and never reaches the Anthropic proxy.
	app.post("/v1/documents/search", async (c) => {
		const claims = requireDocumentClaims(c, config.llmTokenSecret);
		if (claims instanceof Response) return claims;

		const body = await c.req
			.json<{ query?: string }>()
			.catch(() => ({}) as { query?: string });
		if (!body.query) return c.json({ error: "query is required" }, 400);

		const workspaceId = claims.userId;

		try {
			// Server-side scope enforcement — narrow what is searchable.
			let documentIds: string[] | null = null;
			let collectionId: string | null = null;
			if (claims.scope === "document") {
				const docId = await resolveDocumentId(db, {
					summaryId: claims.summaryId ?? "",
					memberCode: claims.userId,
				});
				if (!docId) return c.json({ documents: [] });
				documentIds = [docId];
			} else if (claims.scope === "collection") {
				collectionId = claims.collectionId ?? "";
			}

			const documents = await searchPassages(db, {
				workspaceId,
				query: body.query,
				documentIds,
				collectionId,
				limit: SEARCH_LIMIT,
			});
			return c.json({ documents });
		} catch {
			return c.json({ error: "document search failed" }, 502);
		}
	});

	app.post("/v1/documents/fetch", async (c) => {
		const claims = requireDocumentClaims(c, config.llmTokenSecret);
		if (claims instanceof Response) return claims;

		const body = await c.req
			.json<{ documentId?: string }>()
			.catch(() => ({}) as { documentId?: string });
		if (!body.documentId)
			return c.json({ error: "documentId is required" }, 400);

		const workspaceId = claims.userId;

		try {
			// Server-side scope enforcement — the document must be in scope.
			if (claims.scope === "document") {
				const docId = await resolveDocumentId(db, {
					summaryId: claims.summaryId ?? "",
					memberCode: claims.userId,
				});
				if (!docId || body.documentId !== docId) {
					return forbidden(c, "document out of scope");
				}
			} else if (claims.scope === "collection") {
				const inCollection = await documentInCollection(db, {
					collectionId: claims.collectionId ?? "",
					workspaceId,
					documentId: body.documentId,
				});
				if (!inCollection) return forbidden(c, "document not in collection");
			}

			const doc = await fetchDocument(db, {
				workspaceId,
				documentId: body.documentId,
			});
			if (doc === null) return c.json({ error: "not found" }, 404);
			return c.json(doc);
		} catch {
			return c.json({ error: "document fetch failed" }, 502);
		}
	});

	// 3. LLM proxy — catch-all, registered LAST. A trailing-slash base URL
	//    (`…//v1/messages`) still routes here and gets normalized below.
	app.all("*", (c) => proxyToAnthropic(c, config));

	return app;
}

async function proxyToAnthropic(c: Context, config: GatewayConfig) {
	const claims = bearerClaims(c, config.llmTokenSecret, "llm");
	if (!claims) {
		return c.json(
			{
				type: "error",
				error: {
					type: "authentication_error",
					message: "invalid or expired session token",
				},
			},
			401,
		);
	}

	// Normalize the path before the scope check / forwarding: collapse duplicate
	// slashes (a trailing-slash base URL yields `//v1/messages`) and drop a single
	// trailing slash (`/v1/messages/` → `/v1/messages`) so exact-match still holds.
	const url = new URL(c.req.url);
	let path = url.pathname.replace(/\/{2,}/g, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!ALLOWED_PATHS.has(path)) {
		return c.json(
			{
				type: "error",
				error: {
					type: "not_found_error",
					message: `unsupported path: ${path}`,
				},
			},
			404,
		);
	}

	// Cost-cap / metering hook: claims.userId identifies the end user, and
	// x-claude-code-session-id aggregates a session without parsing the body.

	const headers = new Headers();
	for (const name of FORWARD_REQUEST_HEADERS) {
		const value = c.req.header(name);
		if (value) headers.set(name, value);
	}
	headers.set("x-api-key", config.anthropicApiKey);

	const target = `${config.upstreamBaseUrl}${path}${url.search}`;
	const method = c.req.method;
	const hasBody = method !== "GET" && method !== "HEAD";
	const init: RequestInit & { duplex?: "half" } = { method, headers };
	if (hasBody) {
		init.body = c.req.raw.body;
		// `duplex` is required to stream a request body in undici/Bun but is
		// missing from the RequestInit lib type.
		init.duplex = "half";
	}

	let upstream: Response;
	try {
		upstream = await fetch(target, init);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				type: "error",
				error: {
					type: "api_error",
					message: `upstream request failed: ${message}`,
				},
			},
			502,
		);
	}

	const responseHeaders = new Headers();
	upstream.headers.forEach((value, name) => {
		if (!RESPONSE_DROP_HEADERS.has(name.toLowerCase())) {
			responseHeaders.set(name, value);
		}
	});

	return new Response(upstream.body, {
		status: upstream.status,
		headers: responseHeaders,
	});
}
