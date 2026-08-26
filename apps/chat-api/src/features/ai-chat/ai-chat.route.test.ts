import { expect, it } from "bun:test";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "@/deps";
import aiChatRoutes from "./ai-chat.route";
import type { AgentQueryRuntimeInvoker } from "./http-agent-query-runtime-invoker";

type AgentQueryRequest = Parameters<AgentQueryRuntimeInvoker>[0];

const headers = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};
const requestBody = {
	id: "conversation-1",
	messages: [
		{
			id: "response-1",
			role: "user",
			parts: [{ type: "text", text: "Hello" }],
		},
	],
	model: "anthropic/claude-sonnet-5",
	trigger: "submit-message",
};

const rawClaudeStream = [
	{
		type: "stream_event",
		event: {
			type: "content_block_delta",
			delta: { type: "text_delta", text: "Hello" },
		},
	},
	{
		type: "result",
		subtype: "success",
		is_error: false,
		session_id: "session-1",
	},
]
	.map((message) => JSON.stringify(message))
	.join("\n");

function makeApp(deps: Partial<AppDeps>) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("deps", deps as AppDeps);
		await next();
	});
	app.route("/api/chat", aiChatRoutes);
	return app;
}

it("proxies a query request to the Conversation Runtime", async () => {
	const invocations: AgentQueryRequest[] = [];
	const admitted: unknown[] = [];
	const completed: unknown[] = [];
	const order: string[] = [];
	const app = makeApp({
		exposureGate: { isAgentEnabled: async () => true },
		admitUserMessage: async (message: unknown) => {
			order.push("admit");
			admitted.push(message);
			return { outcome: "admitted" };
		},
		appendAssistantMessage: async (message: unknown) => {
			completed.push(message);
		},
		agentQueryRuntimeInvoker: async (request: AgentQueryRequest) => {
			order.push("invoke");
			invocations.push(request);
			return new Response(`${rawClaudeStream}\n`, {
				headers: {
					"content-type": "application/x-ndjson",
					"x-runtime-header": "preserved",
				},
			});
		},
	});

	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	expect(response.headers.get("x-runtime-header")).toBe("preserved");
	expect(await response.text()).toContain("data: [DONE]");
	expect(admitted).toEqual([
		{
			userId: "member-1",
			conversationId: "conversation-1",
			messageId: "response-1",
			parts: [{ type: "text", text: "Hello" }],
		},
	]);
	expect(order).toEqual(["admit", "invoke"]);
	expect(completed).toEqual([
		{
			userId: "member-1",
			conversationId: "conversation-1",
			messageId: expect.any(String),
			parts: [{ type: "text", text: "Hello", state: "done" }],
		},
	]);
	expect(invocations).toEqual([
		{
			conversationId: "conversation-1",
			model: "anthropic/claude-sonnet-5",
			prompt: "Hello",
		},
	]);
});

it("rejects invalid and exposure-disabled requests before admission", async () => {
	let admissions = 0;
	let invocations = 0;
	const app = makeApp({
		exposureGate: { isAgentEnabled: async () => false },
		admitUserMessage: async () => {
			admissions++;
			return { outcome: "admitted" };
		},
		agentQueryRuntimeInvoker: async () => {
			invocations++;
			return new Response();
		},
	});

	expect(
		(
			await app.request("/api/chat", {
				method: "POST",
				headers,
				body: JSON.stringify({ ...requestBody, messages: [] }),
			})
		).status,
	).toBe(400);
	expect(
		(
			await app.request("/api/chat", {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
			})
		).status,
	).toBe(403);
	expect(admissions).toBe(0);
	expect(invocations).toBe(0);
});

it("returns User-message admission failures without invoking the Runtime", async () => {
	for (const [outcome, status, error] of [
		["not_found", 404, "Conversation not found"],
		["archived", 409, "Conversation is archived"],
		["conflict", 409, "Message id conflict"],
	] as const) {
		let invocations = 0;
		const app = makeApp({
			exposureGate: { isAgentEnabled: async () => true },
			admitUserMessage: async () => ({ outcome }),
			agentQueryRuntimeInvoker: async () => {
				invocations++;
				return new Response();
			},
		});

		const response = await app.request("/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
		expect(invocations).toBe(0);
	}
});
