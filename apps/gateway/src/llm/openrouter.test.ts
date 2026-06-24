import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mintLlmToken } from "@mymemo/llm-token";
import type { Db } from "../db/client";
import { type GatewayConfig, loadConfigFromEnv } from "../env";
import { createGateway } from "../server";

/**
 * OpenRouter provider adapter (Task 17 / MYM-21). Asserts the gateway-side policy
 * switch to OpenRouter: upstream URL construction, credential injection, streaming
 * forwarding through the unchanged Claude-SDK compatibility surface, the
 * compatibility gate (unsupported paths fail closed), and that the OpenRouter key
 * never reaches the caller. The Anthropic path is covered in `server.test.ts`.
 */

const OPENROUTER_KEY = "sk-or-secret-key";
const SECRET = "test-secret";

const config: GatewayConfig = {
	anthropicApiKey: "test-anthropic-key",
	llmTokenSecret: SECRET,
	databaseUrl: "postgres://test@localhost/test",
	upstreamBaseUrl: "https://api.anthropic.com",
	llmProvider: "openrouter",
	openRouter: {
		apiKey: OPENROUTER_KEY,
		baseUrl: "https://openrouter.ai/api",
		defaultModel: "anthropic/claude-sonnet-4.5",
		httpReferer: "https://mymemo.example",
		appTitle: "MyMemo",
	},
	gatewayPort: 8080,
};

// The document reader is not exercised here; an unused fake Db satisfies the seam.
const fakeDb: Db = {
	async query() {
		return [];
	},
};
const app = createGateway(config, fakeDb);

function llmToken(): string {
	return mintLlmToken(
		{ aud: "llm", userId: "u1", sandboxId: "sbx-1", requestId: "req-1" },
		SECRET,
	);
}

describe("gateway · openrouter provider", () => {
	let fetchSpy: ReturnType<typeof spyOn> | undefined;
	afterEach(() => fetchSpy?.mockRestore());

	it("forwards /v1/messages to the OpenRouter base URL", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200 }),
		);
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${llmToken()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
		});
		expect(res.status).toBe(200);
		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/v1/messages");
	});

	it("injects the OpenRouter bearer + attribution headers, never x-api-key", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200 }),
		);
		await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${llmToken()}`,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: "{}",
		});
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const sent = new Headers(init.headers);
		expect(sent.get("authorization")).toBe(`Bearer ${OPENROUTER_KEY}`);
		expect(sent.get("http-referer")).toBe("https://mymemo.example");
		expect(sent.get("x-title")).toBe("MyMemo");
		// The Anthropic credential header must not be set for OpenRouter.
		expect(sent.has("x-api-key")).toBe(false);
		// The Claude SDK's anthropic-version still forwards (compatibility surface).
		expect(sent.get("anthropic-version")).toBe("2023-06-01");
	});

	it("streams an SSE response through unchanged (Claude SDK compatibility smoke)", async () => {
		const chunks = [
			'event: message_start\ndata: {"type":"message_start"}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
			"event: message_stop\ndata: {}\n\n",
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				for (const c of chunks) controller.enqueue(enc.encode(c));
				controller.close();
			},
		});
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${llmToken()}`,
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: JSON.stringify({ model: "x", messages: [], stream: true }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(await res.text()).toBe(chunks.join(""));
	});

	it("fails closed (404) on count_tokens — outside the OpenRouter compat surface", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("must not forward an unsupported path"),
		);
		const res = await app.request("/v1/messages/count_tokens", {
			method: "POST",
			headers: { authorization: `Bearer ${llmToken()}` },
			body: "{}",
		});
		expect(res.status).toBe(404);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(JSON.stringify(await res.json())).toContain("openrouter");
	});

	it("rejects a documents-audience token without forwarding or leaking the key", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("must not forward"),
		);
		const docToken = mintLlmToken(
			{
				aud: "documents",
				userId: "u1",
				sandboxId: "sbx-1",
				requestId: "req-1",
			},
			SECRET,
		);
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: { authorization: `Bearer ${docToken}` },
			body: "{}",
		});
		expect(res.status).toBe(401);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(JSON.stringify(await res.json())).not.toContain(OPENROUTER_KEY);
	});

	it("normalizes an upstream transport failure to 502 without leaking the key", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error(`connect failed to ${OPENROUTER_KEY}@host`),
		);
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${llmToken()}`,
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(res.status).toBe(502);
		const body = JSON.stringify(await res.json());
		// Normalized to a fixed message — the raw upstream error (which here carries
		// the key) is logged, never returned to the untrusted sandbox.
		expect(body).toContain("upstream request failed");
		expect(body).not.toContain(OPENROUTER_KEY);
		expect(body).not.toContain("@host");
	});
});

describe("loadConfigFromEnv · LLM_PROVIDER", () => {
	const base = {
		ANTHROPIC_API_KEY: "ak",
		DATABASE_URL: "postgres://u@h/db",
		LLM_TOKEN_SECRET: "s",
		DB_SSL: "disable",
	};

	it("defaults to the anthropic provider with no openRouter block", () => {
		const cfg = loadConfigFromEnv({ ...base });
		expect(cfg.llmProvider).toBe("anthropic");
		expect(cfg.openRouter).toBeUndefined();
	});

	it("parses the openrouter block and strips a trailing slash from the base URL", () => {
		const cfg = loadConfigFromEnv({
			...base,
			LLM_PROVIDER: "openrouter",
			OPENROUTER_API_KEY: "sk-or",
			OPENROUTER_BASE_URL: "https://openrouter.ai/api/",
			OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4.5",
			OPENROUTER_HTTP_REFERER: "https://mymemo.example",
			OPENROUTER_APP_TITLE: "MyMemo",
		});
		expect(cfg.llmProvider).toBe("openrouter");
		expect(cfg.openRouter).toEqual({
			apiKey: "sk-or",
			baseUrl: "https://openrouter.ai/api",
			defaultModel: "anthropic/claude-sonnet-4.5",
			httpReferer: "https://mymemo.example",
			appTitle: "MyMemo",
		});
	});

	it("rejects an unknown provider", () => {
		expect(() =>
			loadConfigFromEnv({ ...base, LLM_PROVIDER: "bedrock" }),
		).toThrow(/LLM_PROVIDER/);
	});

	it("requires ANTHROPIC_API_KEY for the anthropic provider", () => {
		const { ANTHROPIC_API_KEY: _omit, ...noKey } = base;
		expect(() => loadConfigFromEnv(noKey)).toThrow(/ANTHROPIC_API_KEY/);
	});

	it("does NOT require ANTHROPIC_API_KEY for the openrouter provider", () => {
		const { ANTHROPIC_API_KEY: _omit, ...noKey } = base;
		const cfg = loadConfigFromEnv({
			...noKey,
			LLM_PROVIDER: "openrouter",
			OPENROUTER_API_KEY: "sk-or",
			OPENROUTER_BASE_URL: "https://openrouter.ai/api",
			OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4.5",
		});
		expect(cfg.llmProvider).toBe("openrouter");
		expect(cfg.anthropicApiKey).toBe("");
		expect(cfg.openRouter?.apiKey).toBe("sk-or");
	});

	it("requires the OpenRouter vars when the provider is selected", () => {
		expect(() =>
			loadConfigFromEnv({ ...base, LLM_PROVIDER: "openrouter" }),
		).toThrow(/OPENROUTER_API_KEY/);
		expect(() =>
			loadConfigFromEnv({
				...base,
				LLM_PROVIDER: "openrouter",
				OPENROUTER_API_KEY: "sk-or",
			}),
		).toThrow(/OPENROUTER_BASE_URL/);
		expect(() =>
			loadConfigFromEnv({
				...base,
				LLM_PROVIDER: "openrouter",
				OPENROUTER_API_KEY: "sk-or",
				OPENROUTER_BASE_URL: "https://openrouter.ai/api",
			}),
		).toThrow(/OPENROUTER_DEFAULT_MODEL/);
	});
});
