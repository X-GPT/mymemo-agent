import { sign, verify } from "hono/jwt";
import {
	JwtTokenExpired,
	JwtTokenSignatureMismatched,
} from "hono/utils/jwt/types";

/**
 * Per-Conversation gateway tokens (ADR-0034, #659). chat-api mints one at VM
 * launch and delivers it via `runHookPayload`; the in-VM SDK presents it as its
 * API-key placeholder, and the /v2 gateway route verifies it statelessly before
 * injecting the real OpenRouter credential. The token is an HS256 JWT carrying
 * only `{ conversationId, userId, exp }` — never a provider secret — so nothing
 * VM-bound ever holds a real credential. The Checkpoint route (#670) verifies
 * the same token; its `userId` is what lets chat-api address the
 * Conversation's `conversation_vm` row by primary key.
 */

/**
 * Default lifetime: the platform's 8 h MicroVM `maximum-duration-in-seconds`
 * cap plus an hour of slack, so a token minted at `RunMicrovm` outlives any VM
 * it was delivered to.
 */
export const DEFAULT_GATEWAY_TOKEN_TTL_SECONDS = 9 * 3600;

export interface GatewayTokenClaims {
	conversationId: string;
	/** The Conversation's owner — the other half of its primary key. */
	userId: string;
	/** Expiry, Unix epoch seconds. */
	exp: number;
}

/**
 * Mint a per-Conversation gateway token. Called by orchestration at
 * `RunMicrovm`; the result must fit inside the ≤ 4 KB `runHookPayload`
 * alongside the rest of the VM's launch configuration.
 */
export function mintGatewayToken(options: {
	conversationId: string;
	userId: string;
	secret: string;
	ttlSeconds?: number;
}): Promise<string> {
	const exp =
		Math.floor(Date.now() / 1000) +
		(options.ttlSeconds ?? DEFAULT_GATEWAY_TOKEN_TTL_SECONDS);
	return sign(
		{
			conversationId: options.conversationId,
			userId: options.userId,
			exp,
		} satisfies GatewayTokenClaims,
		options.secret,
	);
}

export type GatewayTokenVerdict =
	| { ok: true; userId: string }
	| {
			ok: false;
			reason: "malformed" | "bad-signature" | "expired" | "wrong-conversation";
	  };

/**
 * Statelessly verify a gateway token against the Conversation the request
 * claims to act for. Every failure is reported by reason for logging — callers
 * should answer all of them with the same opaque 401.
 */
export async function verifyGatewayToken(
	token: string,
	options: { secret: string; conversationId: string },
): Promise<GatewayTokenVerdict> {
	let payload: Record<string, unknown>;
	try {
		payload = await verify(token, options.secret, "HS256");
	} catch (error) {
		if (error instanceof JwtTokenExpired) {
			return { ok: false, reason: "expired" };
		}
		if (error instanceof JwtTokenSignatureMismatched) {
			return { ok: false, reason: "bad-signature" };
		}
		return { ok: false, reason: "malformed" };
	}
	if (typeof payload.exp !== "number" || typeof payload.userId !== "string") {
		return { ok: false, reason: "malformed" };
	}
	if (payload.conversationId !== options.conversationId) {
		return { ok: false, reason: "wrong-conversation" };
	}
	return { ok: true, userId: payload.userId };
}
