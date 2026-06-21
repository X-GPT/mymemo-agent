import type { LlmTokenClaims } from "@mymemo/llm-token";
import type { Context } from "hono";
import { bearerClaims, forbidden, unauthorized } from "./bearer";

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
export function requireDocumentClaims(
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
