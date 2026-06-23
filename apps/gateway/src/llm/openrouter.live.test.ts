import { beforeAll, describe, expect, it } from "bun:test";
import { mintLlmToken } from "@mymemo/llm-token";
import type { Db } from "../db/client";
import { type GatewayConfig, loadConfigFromEnv } from "../env";
import { createGateway } from "../server";

/**
 * LIVE OpenRouter compatibility smoke (Task 17 / MYM-21, Level A).
 *
 * Proves the gateway's OpenRouter adapter works against the REAL OpenRouter
 * Anthropic-compatible Messages endpoint: a streaming `/v1/messages` request with
 * a valid LLM token forwards upstream with the injected bearer key and a
 * real Anthropic-shaped SSE response streams back. The unit suite
 * (`openrouter.test.ts`) covers the same surface with a mocked fetch; this one
 * exercises the actual provider.
 *
 * Gated on OPENROUTER_IT so the normal suite skips it (no network, no spend). Run:
 *   OPENROUTER_IT=1 \
 *   OPENROUTER_API_KEY=sk-or-... \
 *   OPENROUTER_MODEL=anthropic/claude-3.5-haiku \
 *   bun test apps/gateway/src/llm/openrouter.live.test.ts
 *
 * The model MUST be a namespaced OpenRouter id (e.g. `anthropic/claude-3.5-haiku`);
 * this test sends it directly, sidestepping the bare-model-id rewrite that is
 * Task 18 (MYM-22). Defaults to a cheap model if OPENROUTER_MODEL is unset.
 */

const RUN = !!Bun.env.OPENROUTER_IT && !!Bun.env.OPENROUTER_API_KEY;
const SECRET = "test-secret";
const MODEL = Bun.env.OPENROUTER_MODEL || "anthropic/claude-3.5-haiku";

// LLM path never touches the DB; an unused fake satisfies the seam.
const fakeDb: Db = {
	async query() {
		return [];
	},
};

let app: ReturnType<typeof createGateway>;
let apiKey = "";

beforeAll(() => {
	if (!RUN) return;
	// Build config through the real env loader so the OpenRouter wiring
	// (LLM_PROVIDER + OPENROUTER_*) is exercised end-to-end. The provider key is
	// the only true secret; the rest are local stubs (we sign and verify the LLM
	// token with the same injected SECRET, and the DB is never reached).
	const config: GatewayConfig = loadConfigFromEnv({
		ANTHROPIC_API_KEY: "unused-anthropic-key",
		DATABASE_URL: "postgresql://stub@localhost/stub",
		DB_SSL: "disable",
		LLM_TOKEN_SECRET: SECRET,
		LLM_PROVIDER: "openrouter",
		OPENROUTER_API_KEY: Bun.env.OPENROUTER_API_KEY,
		OPENROUTER_BASE_URL:
			Bun.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api",
		OPENROUTER_DEFAULT_MODEL: MODEL,
		OPENROUTER_HTTP_REFERER: "https://mymemo.example",
		OPENROUTER_APP_TITLE: "MyMemo",
	});
	apiKey = config.openRouter?.apiKey ?? "";
	app = createGateway(config, fakeDb);
});

function token(): string {
	return mintLlmToken(
		{ aud: "llm", userId: "it-user", sandboxId: "it-sbx", requestId: "it-req" },
		SECRET,
	);
}

describe.skipIf(!RUN)("gateway · openrouter LIVE compatibility smoke", () => {
	it("streams a real Anthropic-shaped SSE response from OpenRouter", async () => {
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token()}`,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 16,
				stream: true,
				messages: [
					{ role: "user", content: "Reply with the single word: pong" },
				],
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.text();
		// Anthropic Messages streaming shape — the SDK relies on these event types.
		expect(body).toContain("event: message_start");
		expect(body).toContain("content_block_delta");
		expect(body).toContain("message_stop");
		// The injected provider key must never appear in the streamed response.
		expect(body).not.toContain(apiKey);
	}, 30_000);

	it("returns a non-streaming Anthropic-shaped message from OpenRouter", async () => {
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token()}`,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 16,
				messages: [
					{ role: "user", content: "Reply with the single word: pong" },
				],
			}),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { type?: string; role?: string };
		expect(json.type).toBe("message");
		expect(json.role).toBe("assistant");
	}, 30_000);
});
