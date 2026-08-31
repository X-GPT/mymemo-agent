import { describe, expect, it } from "bun:test";
import { mintGatewayToken, verifyGatewayToken } from "./gateway-token";

const SECRET = "test-gateway-signing-secret";
const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";

describe("gateway token mint/verify", () => {
	it("round-trips a validly minted token", () => {
		const token = mintGatewayToken({
			conversationId: CONVERSATION_ID,
			secret: SECRET,
		});
		const verdict = verifyGatewayToken(token, {
			secret: SECRET,
			conversationId: CONVERSATION_ID,
		});
		expect(verdict).toEqual({
			ok: true,
			claims: { conversationId: CONVERSATION_ID, exp: expect.any(Number) },
		});
	});

	it("rejects an expired token", () => {
		const token = mintGatewayToken({
			conversationId: CONVERSATION_ID,
			secret: SECRET,
			ttlSeconds: 60,
			now: 0,
		});
		const verdict = verifyGatewayToken(token, {
			secret: SECRET,
			conversationId: CONVERSATION_ID,
			now: 61_000,
		});
		expect(verdict).toEqual({ ok: false, reason: "expired" });
	});

	it("rejects a token minted for another Conversation", () => {
		const token = mintGatewayToken({
			conversationId: "99999999-2222-4333-8444-555555555555",
			secret: SECRET,
		});
		const verdict = verifyGatewayToken(token, {
			secret: SECRET,
			conversationId: CONVERSATION_ID,
		});
		expect(verdict).toEqual({ ok: false, reason: "wrong-conversation" });
	});

	it("rejects a tampered payload and a wrong secret", () => {
		const token = mintGatewayToken({
			conversationId: CONVERSATION_ID,
			secret: SECRET,
		});
		const [prefix, payload, signature] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify({ conversationId: CONVERSATION_ID, exp: 9999999999 }),
		).toString("base64url");
		expect(
			verifyGatewayToken(`${prefix}.${forged}.${signature}`, {
				secret: SECRET,
				conversationId: CONVERSATION_ID,
			}),
		).toEqual({ ok: false, reason: "bad-signature" });
		expect(
			verifyGatewayToken(`${prefix}.${payload}.${signature}`, {
				secret: "another-secret",
				conversationId: CONVERSATION_ID,
			}),
		).toEqual({ ok: false, reason: "bad-signature" });
	});

	it("rejects garbage without throwing", () => {
		for (const junk of ["", "Bearer", "a.b", "mmgw1.!!!.???"]) {
			const verdict = verifyGatewayToken(junk, {
				secret: SECRET,
				conversationId: CONVERSATION_ID,
			});
			expect(verdict.ok).toBe(false);
		}
	});

	it("mints a payload that fits runHookPayload (≤ 4 KB) with room to spare", () => {
		const token = mintGatewayToken({
			conversationId: CONVERSATION_ID,
			secret: SECRET,
		});
		// The token is one field of the launch payload; keep it well under the cap.
		expect(Buffer.byteLength(token)).toBeLessThan(512);
	});

	it("carries only conversationId and exp — no field can smuggle a provider key to the VM", () => {
		const token = mintGatewayToken({
			conversationId: CONVERSATION_ID,
			secret: SECRET,
		});
		const claims = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
		);
		expect(Object.keys(claims).sort()).toEqual(["conversationId", "exp"]);
	});
});
