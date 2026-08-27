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
	const created = {
		destroy: async () => {
			events.push("destroy");
		},
	};
	const fake = {
		createSession: async (options: { sessionId: string }) => {
			events.push({ createSession: options });
			return created;
		},
		stream: async ({
			session,
			...options
		}: {
			session: unknown;
			prompt: string;
			abortSignal?: AbortSignal;
		}) => {
			events.push({ stream: options, sameSession: session === created });
			return {
				toUIMessageStreamResponse: (_options: {
					onError: (error: unknown) => string;
				}) => streamResponse(uiMessageStream),
			};
		},
	};
	return { agent: fake as unknown as HarnessChatAgent, events, fake };
}

function streamResponse(body: ConstructorParameters<typeof Response>[0]) {
	return new Response(body, {
		headers: {
			"content-type": "text/event-stream",
			"x-vercel-ai-ui-message-stream": "v1",
		},
	});
}

const logged: unknown[] = [];
const logger = {
	error: (obj: unknown, msg: string) =>
		logged.push({ level: "error", obj, msg }),
	warn: (obj: unknown, msg: string) => logged.push({ level: "warn", obj, msg }),
};

function makeApp(deps: Partial<AppDeps>) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("deps", deps as AppDeps);
		c.set("logger", logger as never);
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
			createSession: { sessionId: "conversation-1" },
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

it("passes the request's own abort signal to the turn", async () => {
	const { agent, events } = fakeAgent();
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		harnessChatAgent: agent,
	});
	const controller = new AbortController();
	await app.request(
		new Request("http://localhost/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: controller.signal,
		}),
	);
	const streamEvent = events[1] as { stream: { abortSignal?: AbortSignal } };
	expect(streamEvent.stream.abortSignal).toBe(controller.signal);
});

it("ends an aborted turn cleanly with the abort part and still destroys the session", async () => {
	const { agent, events, fake } = fakeAgent();
	const controller = new AbortController();
	// Mirrors HarnessAgent: on abort the turn settles with a final `abort` part.
	fake.stream = async ({ abortSignal }) => ({
		toUIMessageStreamResponse: () =>
			streamResponse(
				new ReadableStream({
					start(c) {
						abortSignal?.addEventListener("abort", () => {
							c.enqueue('data: {"type":"abort"}\n\ndata: [DONE]\n\n');
							c.close();
						});
					},
				}),
			),
	});
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		harnessChatAgent: agent,
	});
	const response = await app.request(
		new Request("http://localhost/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: controller.signal,
		}),
	);
	expect(response.status).toBe(200);
	const text = response.text();
	controller.abort();
	expect(await text).toContain('{"type":"abort"}');
	expect(events.at(-1)).toBe("destroy");
});

it("destroys the session and logs when the turn fails to start", async () => {
	const { agent, events, fake } = fakeAgent();
	fake.stream = async () => {
		throw new Error("bridge unavailable");
	};
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		harnessChatAgent: agent,
	});
	logged.length = 0;
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(response.status).toBe(500);
	expect(await response.text()).not.toContain("bridge unavailable");
	expect(events.at(-1)).toBe("destroy");
	expect(logged).toEqual([
		{
			level: "error",
			obj: { err: expect.any(Error), conversationId: "conversation-1" },
			msg: "harness turn failed to start",
		},
	]);
});

it("hides the cause of a mid-stream failure from the client, logs it, and destroys the session", async () => {
	const { agent, events, fake } = fakeAgent();
	// Mirrors the AI SDK: a failing turn becomes an `error` part whose text is `onError`'s return.
	fake.stream = async () => ({
		toUIMessageStreamResponse: (options: {
			onError: (error: unknown) => string;
		}) =>
			streamResponse(
				`data: {"type":"error","errorText":${JSON.stringify(
					options.onError(new Error("model exploded")),
				)}}\n\ndata: [DONE]\n\n`,
			),
	});
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		harnessChatAgent: agent,
	});
	logged.length = 0;
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).toContain('"errorText":"An error occurred."');
	expect(text).not.toContain("model exploded");
	expect(events.at(-1)).toBe("destroy");
	expect(logged).toEqual([
		{
			level: "error",
			obj: { err: expect.any(Error), conversationId: "conversation-1" },
			msg: "harness turn failed while streaming",
		},
	]);
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
