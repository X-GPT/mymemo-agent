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
const rawClaudeStream = '{"type":"result","subtype":"success"}\n';

function makeApp(deps: Partial<AppDeps>) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("deps", deps as AppDeps);
		await next();
	});
	app.route("/api/chat", aiChatRoutes);
	return app;
}

it("returns the owned Conversation Runtime stream unchanged", async () => {
	const invocations: AgentQueryRequest[] = [];
	const lookups: unknown[] = [];
	const app = makeApp({
		conversationStore: {
			get: async (input: unknown) => {
				lookups.push(input);
				return { archivedAt: null } as never;
			},
		} as unknown as AppDeps["conversationStore"],
		exposureGate: { isAgentEnabled: async () => true },
		agentQueryRuntimeInvoker: async (request) => {
			invocations.push(request);
			return new Response(rawClaudeStream, {
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
	expect(response.headers.get("content-type")).toBe("application/x-ndjson");
	expect(response.headers.get("x-runtime-header")).toBe("preserved");
	expect(await response.text()).toBe(rawClaudeStream);
	expect(lookups).toEqual([
		{ userId: "member-1", conversationId: "conversation-1" },
	]);
	expect(invocations).toEqual([
		{
			conversationId: "conversation-1",
			runId: "response-1",
			model: "anthropic/claude-sonnet-5",
			prompt: "Hello",
		},
	]);
});

it("rejects invalid and exposure-disabled requests before invocation", async () => {
	let invocations = 0;
	const app = makeApp({
		conversationStore: {
			get: async () => ({ archivedAt: null }) as never,
		} as unknown as AppDeps["conversationStore"],
		exposureGate: { isAgentEnabled: async () => false },
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
	expect(invocations).toBe(0);
});

it.each([
	[null, 404, "Conversation not found"],
	[{ archivedAt: new Date() }, 409, "Conversation is archived"],
] as const)("rejects a missing or archived Conversation before invocation", async (conversation, status, error) => {
	let gateChecks = 0;
	let invocations = 0;
	const app = makeApp({
		conversationStore: {
			get: async () => conversation as never,
		} as unknown as AppDeps["conversationStore"],
		exposureGate: {
			isAgentEnabled: async () => {
				gateChecks++;
				return true;
			},
		},
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
	expect(gateChecks).toBe(0);
	expect(invocations).toBe(0);
});
