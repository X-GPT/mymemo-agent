import {
	type LlmTokenClaims,
	type TokenAudience,
	verifyLlmToken,
} from "@mymemo/llm-token";
import type { Context } from "hono";

/**
 * The single token-verify seam, shared by both route families. Each family
 * passes its own audience so a token minted for the other family fails closed
 * here: an `llm` token cannot reach the document routes and a `documents` token
 * cannot reach the LLM proxy. Both `llm/proxy.ts` and `auth/claims.ts` call
 * this, so there is exactly one verification implementation.
 */
export function bearerClaims(
	c: Context,
	secret: string,
	audience: TokenAudience,
): LlmTokenClaims | null {
	const auth = c.req.header("authorization")?.trim() ?? "";
	const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? "";
	return verifyLlmToken(token, secret, audience);
}

export function unauthorized(c: Context) {
	return c.json({ error: "invalid or expired token" }, 401);
}

export function forbidden(c: Context, message: string) {
	return c.json({ error: message }, 403);
}
