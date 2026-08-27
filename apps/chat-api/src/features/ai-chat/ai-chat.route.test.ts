import { expect, it } from "bun:test";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "@/deps";
import aiChatRoutes from "./ai-chat.route";
import type { HarnessChatAgent } from "./harness-chat-agent";

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

const uiMessageStream =
	'data: {"type":"text-delta","id":"t1","delta":"Hi"}\n\ndata: [DONE]\n\n';

/** Fake agent that records the lifecycle and streams a canned UI message stream. */
function fakeAgent() {
	const events: unknown[] = [];
	const agent: HarnessChatAgent = {
		createSession: async (options) => {
			events.push({ createSession: options });
			return {
				destroy: async () => {
					events.push("destroy");
				},
			};
		},
		stream: async ({ session, ...options }) => {
			events.push({ stream: options, sameSession: session !== undefined });
			return {
				toUIMessageStreamResponse: () =>
					new Response(uiMessageStream, {
						headers: {
							"content-type": "text/event-stream",
							"x-vercel-ai-ui-message-stream": "v1",
						},
					}),
			};
		},
	};
	return { agent, events };
}

function makeApp(deps: Partial<AppDeps>) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("deps", deps as AppDeps);
		await next();
	});
	app.route("/api/chat", aiChatRoutes);
	return app;
}

const ownedConversation = {
	get: async () => ({ archivedAt: null }) as never,
} as unknown as AppDeps["conversationStore"];

it("runs one Harness turn in a session named after the Conversation and destroys it after the stream", async () => {
	const { agent, events } = fakeAgent();
	const lookups: unknown[] = [];
	const app = makeApp({
		conversationStore: {
			get: async (input: unknown) => {
				lookups.push(input);
				return { archivedAt: null } as never;
			},
		} as unknown as AppDeps["conversationStore"],
		exposureGate: { isAgentEnabled: async () => true },
		harnessChatAgent: agent,
	});

	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});

	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
	expect(lookups).toEqual([
		{ userId: "member-1", conversationId: "conversation-1" },
	]);
	// The session is not destroyed until the client has drained the stream.
	expect(events).toEqual([
		{
			createSession: {
				sessionId: "conversation-1",
				model: "anthropic/claude-sonnet-5",
			},
		},
		{
			stream: { prompt: "Hello", abortSignal: expect.any(AbortSignal) },
			sameSession: true,
		},
	]);
	expect(await response.text()).toBe(uiMessageStream);
	expect(events.at(-1)).toBe("destroy");
});

it("destroys the session when the client cancels the stream", async () => {
	const { agent, events } = fakeAgent();
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		harnessChatAgent: agent,
	});
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(events).not.toContain("destroy");
	await response.body?.cancel();
	expect(events.at(-1)).toBe("destroy");
});

it("destroys the session when the turn fails to start", async () => {
	const { agent, events } = fakeAgent();
	agent.stream = async () => {
		throw new Error("bridge unavailable");
	};
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		harnessChatAgent: agent,
	});
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(response.status).toBe(500);
	expect(events.at(-1)).toBe("destroy");
});

it("rejects invalid and exposure-disabled requests before creating a session", async () => {
	const { agent, events } = fakeAgent();
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => false },
		harnessChatAgent: agent,
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
	expect(events).toEqual([]);
});

it.each([
	[null, 404, "Conversation not found"],
	[{ archivedAt: new Date() }, 409, "Conversation is archived"],
] as const)("rejects a missing or archived Conversation before creating a session", async (conversation, status, error) => {
	const { agent, events } = fakeAgent();
	let gateChecks = 0;
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
		harnessChatAgent: agent,
	});

	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});

	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ error });
	expect(gateChecks).toBe(0);
	expect(events).toEqual([]);
});
