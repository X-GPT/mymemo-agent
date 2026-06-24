import type { Context } from "hono";
import { bearerClaims } from "../auth/bearer";
import type { GatewayConfig } from "../env";
import type { LlmProvider } from "./providers";

/**
 * LLM proxy. Sandboxed agents point the Claude binary at the gateway via
 * ANTHROPIC_BASE_URL and authenticate with a short-lived bearer token. The agent
 * holds no provider key: we validate the token, hand the request to the selected
 * provider (which injects the real upstream credential), and stream the upstream
 * response back. Scope is narrow — only the provider's compatibility surface is
 * forwarded and only an allowlist of request headers is sent, so a leaked token
 * cannot reach files/batches/admin endpoints and no client headers leak upstream.
 *
 * The upstream provider (Anthropic direct vs. OpenRouter's Anthropic-compatible
 * endpoint) is a gateway-side policy decision; the sandbox is unaware of it. Both
 * speak the Anthropic Messages wire format, so the SDK compatibility surface is
 * unchanged and the streamed response forwards through verbatim.
 */

// The only request headers forwarded upstream. The provider replaces auth
// (x-api-key or Authorization); everything else (host, content-length,
// accept-encoding, cookie, …) is dropped so fetch controls compression and
// nothing leaks upstream.
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

export async function proxyLlm(
	c: Context,
	config: GatewayConfig,
	provider: LlmProvider,
) {
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
	// The provider gates its own compatibility surface: a path the upstream cannot
	// honor (e.g. count_tokens on OpenRouter) fails closed here with a clear 404
	// instead of forwarding and erroring opaquely upstream.
	if (!provider.supportsPath(path)) {
		return c.json(
			{
				type: "error",
				error: {
					type: "not_found_error",
					message: `unsupported path for provider ${provider.name}: ${path}`,
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
	provider.authorizeUpstream(headers);

	const target = provider.upstreamUrl(path, url.search);
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
		// Normalize to a fixed, non-secret-bearing message. The raw transport error
		// is logged for operators but never echoed to the untrusted sandbox agent —
		// it can carry upstream URLs/hosts (and, defensively, must never carry the
		// injected provider credential).
		console.error(`[gateway] ${provider.name} upstream request failed:`, err);
		return c.json(
			{
				type: "error",
				error: { type: "api_error", message: "upstream request failed" },
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
