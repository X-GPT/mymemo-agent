import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { ApiConfig } from "@/config/env";
import type { AppDeps, AppEnv } from "@/deps";
import gatewayRoutes from "./gateway.route";
import { mintGatewayToken } from "./gateway-token";

const SECRET = "test-gateway-signing-secret";
const OPENROUTER_KEY = "sk-or-real-upstream-key";
const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";

const logged: { level: string; obj: Record<string, unknown>; msg: string }[] =
	[];
const logger = {
	info: (obj: Record<string, unknown>, msg: string) =>
		logged.push({ level: "info", obj, msg }),
	warn: (obj: Record<string, unknown>, msg: string) =>
		logged.push({ level: "warn", obj, msg }),
};

beforeEach(() => {
	logged.length = 0;
});

function gatewayConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
	return {
		openrouterApiKey: OPENROUTER_KEY,
		openrouterBaseUrl: "https://openrouter.test/api",
		gatewayTokenSecret: SECRET,
		...overrides,
	} as ApiConfig;
}

function makeApp(config: ApiConfig, fetchImpl: typeof fetch) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("deps", { config, gatewayUpstreamFetch: fetchImpl } as AppDeps);
		c.set("logger", logger as never);
		await next();
	});
	app.route("/v2/gateway", gatewayRoutes);
	return app;
}

/** Record the upstream request and answer with `response`. */
function fakeUpstream(response: () => Response) {
	const calls: Request[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push(new Request(input as string, init));
		return response();
	}) as typeof fetch;
	return { calls, fetchImpl };
}

function validToken(conversationId = CONVERSATION_ID): string {
	return mintGatewayToken({ conversationId, secret: SECRET });
}

const SSE_BODY = [
	`data: {"type":"message_start","message":{"model":"anthropic/claude-sonnet-5","usage":{"input_tokens":12}}}`,
	"",
	`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`,
	"",
	`data: {"type":"message_delta","usage":{"output_tokens":34}}`,
	"",
	"data: [DONE]",
	"",
].join("\n");

describe("POST /v2/gateway/:conversationId/*", () => {
	it("forwards a tokened request with the real key injected and streams the SSE body through", async () => {
		const { calls, fetchImpl } = fakeUpstream(
			() =>
				new Response(SSE_BODY, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const app = makeApp(gatewayConfig(), fetchImpl);

		const response = await app.request(
			`/v2/gateway/${CONVERSATION_ID}/v1/messages?beta=true`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${validToken()}`,
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
					"x-api-key": "placeholder-should-not-forward",
				},
				body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toBe(SSE_BODY);

		expect(calls).toHaveLength(1);
		const upstream = calls[0];
		if (!upstream) throw new Error("upstream was not called");
		expect(upstream.url).toBe(
			"https://openrouter.test/api/v1/messages?beta=true",
		);
		expect(upstream.method).toBe("POST");
		// The real credential replaces the token; the placeholder header is gone.
		expect(upstream.headers.get("authorization")).toBe(
			`Bearer ${OPENROUTER_KEY}`,
		);
		expect(upstream.headers.get("x-api-key")).toBeNull();
		expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(await upstream.text()).toBe(
			JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
		);
	});

	it("logs per-Conversation usage scraped from the SSE stream", async () => {
		const { fetchImpl } = fakeUpstream(
			() =>
				new Response(SSE_BODY, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const app = makeApp(gatewayConfig(), fetchImpl);

		const response = await app.request(
			`/v2/gateway/${CONVERSATION_ID}/v1/messages`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${validToken()}` },
				body: "{}",
			},
		);
		await response.text();

		const usageLines = logged.filter((l) => l.msg === "gateway model call");
		expect(usageLines).toHaveLength(1);
		expect(usageLines[0]?.obj).toMatchObject({
			conversationId: CONVERSATION_ID,
			path: "/v1/messages",
			status: 200,
			outcome: "complete",
			model: "anthropic/claude-sonnet-5",
			usage: { input_tokens: 12, output_tokens: 34 },
		});
	});

	it("logs usage from a non-streaming JSON response", async () => {
		const { fetchImpl } = fakeUpstream(
			() =>
				new Response(
					JSON.stringify({
						model: "anthropic/claude-sonnet-5",
						usage: { input_tokens: 5, output_tokens: 7 },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const app = makeApp(gatewayConfig(), fetchImpl);

		const response = await app.request(
			`/v2/gateway/${CONVERSATION_ID}/v1/messages`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${validToken()}` },
				body: "{}",
			},
		);
		await response.text();

		const usageLines = logged.filter((l) => l.msg === "gateway model call");
		expect(usageLines).toHaveLength(1);
		expect(usageLines[0]?.obj).toMatchObject({
			conversationId: CONVERSATION_ID,
			usage: { input_tokens: 5, output_tokens: 7 },
		});
	});

	it.each([
		["missing", undefined],
		["garbage", "Bearer not-a-token"],
		[
			"expired",
			`Bearer ${mintGatewayToken({
				conversationId: CONVERSATION_ID,
				secret: SECRET,
				ttlSeconds: 1,
				now: 0,
			})}`,
		],
		[
			"wrong-secret",
			`Bearer ${mintGatewayToken({ conversationId: CONVERSATION_ID, secret: "other" })}`,
		],
		[
			"wrong-conversation",
			`Bearer ${mintGatewayToken({ conversationId: "99999999-2222-4333-8444-555555555555", secret: SECRET })}`,
		],
	])("rejects a %s token with 401 and never calls upstream", async (_name, authorization) => {
		const { calls, fetchImpl } = fakeUpstream(() => new Response("nope"));
		const app = makeApp(gatewayConfig(), fetchImpl);

		const response = await app.request(
			`/v2/gateway/${CONVERSATION_ID}/v1/messages`,
			{
				method: "POST",
				headers: authorization ? { authorization } : {},
				body: "{}",
			},
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		expect(calls).toHaveLength(0);
		expect(logged.some((l) => l.msg === "gateway token rejected")).toBe(true);
	});

	it("answers 503 without calling upstream when the gateway secrets are absent", async () => {
		const { calls, fetchImpl } = fakeUpstream(() => new Response("nope"));
		const app = makeApp(
			gatewayConfig({
				openrouterApiKey: undefined,
				gatewayTokenSecret: undefined,
			}),
			fetchImpl,
		);

		const response = await app.request(
			`/v2/gateway/${CONVERSATION_ID}/v1/messages`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${validToken()}` },
				body: "{}",
			},
		);

		expect(response.status).toBe(503);
		expect(calls).toHaveLength(0);
	});

	it("passes upstream error responses through unchanged", async () => {
		const { fetchImpl } = fakeUpstream(
			() =>
				new Response(JSON.stringify({ error: "rate limited" }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		const app = makeApp(gatewayConfig(), fetchImpl);

		const response = await app.request(
			`/v2/gateway/${CONVERSATION_ID}/v1/messages`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${validToken()}` },
				body: "{}",
			},
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ error: "rate limited" });
	});
});
