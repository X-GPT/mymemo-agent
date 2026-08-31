import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-Conversation gateway tokens (ADR-0034, #659). chat-api mints one at VM
 * launch and delivers it via `runHookPayload`; the in-VM SDK presents it as its
 * API-key placeholder, and the /v2 gateway route verifies it statelessly before
 * injecting the real OpenRouter credential. The token carries only
 * `{ conversationId, exp }` — never a provider secret — so nothing VM-bound
 * ever holds a real credential.
 */

const TOKEN_PREFIX = "mmgw1";

/**
 * Default lifetime: the platform's 8 h MicroVM `maximum-duration-in-seconds`
 * cap plus an hour of slack, so a token minted at `RunMicrovm` outlives any VM
 * it was delivered to.
 */
export const DEFAULT_GATEWAY_TOKEN_TTL_SECONDS = 9 * 3600;

export interface GatewayTokenClaims {
	conversationId: string;
	/** Expiry, Unix epoch seconds. */
	exp: number;
}

function sign(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a per-Conversation gateway token. Called by orchestration at
 * `RunMicrovm`; the result must fit inside the ≤ 4 KB `runHookPayload`
 * alongside the rest of the VM's launch configuration.
 */
export function mintGatewayToken(options: {
	conversationId: string;
	secret: string;
	ttlSeconds?: number;
	/** Epoch milliseconds; defaults to the wall clock. */
	now?: number;
}): string {
	const exp =
		Math.floor((options.now ?? Date.now()) / 1000) +
		(options.ttlSeconds ?? DEFAULT_GATEWAY_TOKEN_TTL_SECONDS);
	const payload = Buffer.from(
		JSON.stringify({ conversationId: options.conversationId, exp }),
	).toString("base64url");
	return `${TOKEN_PREFIX}.${payload}.${sign(payload, options.secret)}`;
}

export type GatewayTokenVerdict =
	| { ok: true; claims: GatewayTokenClaims }
	| {
			ok: false;
			reason: "malformed" | "bad-signature" | "expired" | "wrong-conversation";
	  };

/**
 * Statelessly verify a gateway token against the Conversation the request
 * claims to act for. The signature is checked before the payload is parsed so
 * unauthenticated input never reaches JSON.parse, and every failure is
 * reported by reason for logging — callers should answer all of them with the
 * same opaque 401.
 */
export function verifyGatewayToken(
	token: string,
	options: {
		secret: string;
		conversationId: string;
		/** Epoch milliseconds; defaults to the wall clock. */
		now?: number;
	},
): GatewayTokenVerdict {
	const [prefix, payload, signature, ...rest] = token.split(".");
	if (
		prefix !== TOKEN_PREFIX ||
		payload === undefined ||
		signature === undefined ||
		rest.length > 0
	) {
		return { ok: false, reason: "malformed" };
	}
	const expected = Buffer.from(sign(payload, options.secret));
	const presented = Buffer.from(signature);
	if (
		presented.length !== expected.length ||
		!timingSafeEqual(presented, expected)
	) {
		return { ok: false, reason: "bad-signature" };
	}
	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(payload, "base64url").toString());
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (
		typeof claims !== "object" ||
		claims === null ||
		typeof (claims as GatewayTokenClaims).conversationId !== "string" ||
		typeof (claims as GatewayTokenClaims).exp !== "number"
	) {
		return { ok: false, reason: "malformed" };
	}
	const parsed = claims as GatewayTokenClaims;
	if (parsed.exp * 1000 <= (options.now ?? Date.now())) {
		return { ok: false, reason: "expired" };
	}
	if (parsed.conversationId !== options.conversationId) {
		return { ok: false, reason: "wrong-conversation" };
	}
	return { ok: true, claims: parsed };
}
