/**
 * Stateless session token for the LLM control plane.
 *
 * chat-api mints a short-lived token per turn; llm-gateway verifies it before
 * proxying to Anthropic with the real key. The token is a signed, self-describing
 * blob — no database lookup — so the gateway can stay stateless and horizontally
 * scalable. The signing secret is passed in by the caller (read from each app's
 * env) so this package has no dependency on a particular env shape.
 *
 * Wire format: `<base64url(payload)>.<base64url(hmac-sha256)>`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Which gateway route family a token is valid for. The gateway enforces this
 * per route, so an `llm` token cannot reach the document routes and vice versa:
 * a leaked LLM token cannot read documents, and a leaked document token cannot
 * spend on the LLM. chat-api mints one token per audience for each turn.
 */
export type TokenAudience = "llm" | "documents";

export interface LlmTokenClaims {
	/** Route family this token is valid for; enforced by the gateway. */
	aud: TokenAudience;
	userId: string;
	sandboxId: string;
	requestId: string;
	/** Expiry as ms since epoch. */
	exp: number;
	/** Product-visible conversation thread id this run belongs to. */
	conversationId?: string;
	/** Backend execution attempt id. */
	runId?: string;
	/**
	 * The turn's document scope. The document routes enforce this server-side
	 * (the agent cannot widen it, since it's signed). Set on the
	 * documents-audience token (always — `global` is the workspace-wide search
	 * scope); the llm-audience token omits it.
	 */
	scope?: "global" | "collection" | "document";
	/** Present iff scope === "collection". */
	collectionId?: string;
	/** Present iff scope === "document". */
	summaryId?: string;
}

const DEFAULT_TTL_MS = 10 * 60_000;

function sign(body: string, secret: string): string {
	return createHmac("sha256", secret).update(body).digest("base64url");
}

function isLlmTokenClaims(value: unknown): value is LlmTokenClaims {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Record<string, unknown>;
	return (
		// Audience is security-critical and route-enforced, so a token whose `aud`
		// is missing or not one of the known values is rejected outright rather
		// than left for a route to mis-handle.
		(c.aud === "llm" || c.aud === "documents") &&
		typeof c.userId === "string" &&
		typeof c.sandboxId === "string" &&
		typeof c.requestId === "string" &&
		// Number.isFinite (not `typeof === "number"`) so a signed `{"exp":1e999}`
		// → Infinity is rejected instead of being treated as never-expiring.
		Number.isFinite(c.exp)
	);
}

export function mintLlmToken(
	claims: Omit<LlmTokenClaims, "exp">,
	secret: string,
	ttlMs: number = DEFAULT_TTL_MS,
): string {
	const payload: LlmTokenClaims = { ...claims, exp: Date.now() + ttlMs };
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${body}.${sign(body, secret)}`;
}

export function verifyLlmToken(
	token: string,
	secret: string,
	/**
	 * When provided, the token's `aud` must match or verification fails closed.
	 * Each gateway route family passes its own audience so a token minted for the
	 * other family is rejected.
	 */
	audience?: TokenAudience,
): LlmTokenClaims | null {
	const dot = token.indexOf(".");
	if (dot < 1) return null;

	const body = token.slice(0, dot);
	const presented = Buffer.from(token.slice(dot + 1));
	const expected = Buffer.from(sign(body, secret));
	if (
		presented.length !== expected.length ||
		!timingSafeEqual(presented, expected)
	) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body, "base64url").toString());
	} catch {
		return null;
	}
	// A valid signature only proves the secret-holder produced the payload; it
	// does not guarantee shape. Reject anything that isn't well-formed claims so
	// callers never see a non-object or a missing/non-numeric exp (which would
	// make `exp < Date.now()` falsy and silently "never expire").
	if (!isLlmTokenClaims(parsed)) return null;
	if (audience !== undefined && parsed.aud !== audience) return null;
	return parsed.exp < Date.now() ? null : parsed;
}
