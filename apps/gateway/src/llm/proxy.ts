import type { Context } from "hono";
import { bearerClaims } from "../auth/bearer";
import type { GatewayConfig } from "../env";

/**
 * LLM proxy. Sandboxed agents point the Claude binary at the gateway via
 * ANTHROPIC_BASE_URL and authenticate with a short-lived bearer token. The agent
 * holds no provider key: we validate the token, inject the real `x-api-key`, and
 * stream the upstream response back. Scope is narrow — only the Anthropic
 * Messages endpoints are proxied and only an allowlist of request headers is
 * forwarded, so a leaked token cannot reach files/batches/admin endpoints and no
 * client headers leak upstream.
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

export async function proxyToAnthropic(c: Context, config: GatewayConfig) {
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
