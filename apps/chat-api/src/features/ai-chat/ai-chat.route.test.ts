import { expect, it } from "bun:test";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "@/deps";
import aiChatRoutes from "./ai-chat.route";
import type {
	HarnessChatAgentFactory,
	HarnessTurn,
} from "./harness-chat-agent";

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

/** What the fake session's `stop()` returns; opaque to the route. */
const stoppedState: { type: string; data: unknown; continueFrom?: unknown } = {
	type: "resume-session",
	data: { after: "turn" },
};

/** In-memory resume pointer store, optionally pre-seeded for conversation-1. */
function fakeResumeStore(initial: unknown = null) {
	const saved: { ref: unknown; state: unknown }[] = [];
	const store = {
		// Reads back the last save, so a later turn sees what an earlier one left.
		load: async () => saved.at(-1)?.state ?? initial,
		save: async (ref: unknown, state: unknown) => {
			saved.push({ ref, state });
		},
	};
	return {
		store: store as unknown as AppDeps["harnessResumeStateStore"],
		saved,
	};
}

/**
 * Fake agent factory: records the turn of every agent it builds, and the
 * agent records the lifecycle and streams a canned UI message stream.
 */
function fakeAgent() {
	const events: unknown[] = [];
	const turns: HarnessTurn[] = [];
	const created = {
		stop: async () => {
			events.push("stop");
			return stoppedState;
		},
	};
	const fake = {
		createSession: async (options: {
			sessionId: string;
			resumeFrom?: unknown;
		}) => {
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
				// Typed so the mid-stream failure test can override it with a real `onError`.
				toUIMessageStreamResponse: (_options: {
					onError: (error: unknown) => string;
				}) => streamResponse(uiMessageStream),
			};
		},
	};
	const factory: HarnessChatAgentFactory = (turn) => {
		turns.push(turn);
		return fake as never;
	};
	return { factory, events, fake, turns };
}

/** The JSON parts of a UI message stream body, `[DONE]` excluded. */
function streamParts(body: string): Record<string, unknown>[] {
	return body
		.split("\n\n")
		.filter((line) => line.startsWith("data: {"))
		.map((line) => JSON.parse(line.slice("data: ".length)));
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

const documentAccessLog: AppDeps["documentAccessLog"] = {
	record: async () => {},
};

function makeApp(deps: Partial<AppDeps>) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("deps", {
			harnessResumeStateStore: fakeResumeStore().store,
			documentAccessLog,
			...deps,
		} as AppDeps);
		c.set("logger", logger as never);
		await next();
	});
	app.route("/api/chat", aiChatRoutes);
	return app;
}

const conversationRow = {
	archivedAt: null,
	scope: "general",
	collectionId: null,
	summaryId: null,
};

const ownedConversation = {
	get: async () => conversationRow as never,
} as unknown as AppDeps["conversationStore"];

it("runs one Harness turn in a session named after the Conversation and stops it after the stream", async () => {
	const { factory, events } = fakeAgent();
	const { store, saved } = fakeResumeStore();
	const lookups: unknown[] = [];
	const app = makeApp({
		conversationStore: {
			get: async (input: unknown) => {
				lookups.push(input);
				return conversationRow as never;
			},
		} as unknown as AppDeps["conversationStore"],
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
		harnessResumeStateStore: store,
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
	// The session is not stopped until the client has drained the stream.
	expect(events).toEqual([
		{
			createSession: { sessionId: "conversation-1" },
		},
		{
			stream: { prompt: "Hello", abortSignal: expect.any(AbortSignal) },
			sameSession: true,
		},
	]);
	// The pointer never appears in the stream; it is stored after `stop()`.
	expect(await response.text()).toBe(uiMessageStream);
	expect(events.at(-1)).toBe("stop");
	expect(saved).toEqual([
		{
			ref: { userId: "member-1", conversationId: "conversation-1" },
			state: stoppedState,
		},
	]);
});

it("builds one agent per turn, bound to a fresh Harness turn id and the Conversation's frozen scope", async () => {
	const { factory, turns } = fakeAgent();
	const app = makeApp({
		conversationStore: {
			get: async ({ conversationId }: { conversationId: string }) =>
				({
					...conversationRow,
					scope: conversationId === "conversation-2" ? "collection" : "general",
					collectionId: conversationId === "conversation-2" ? "coll-7" : null,
				}) as never,
		} as unknown as AppDeps["conversationStore"],
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
	});
	for (const id of ["conversation-1", "conversation-2"]) {
		const response = await app.request("/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...requestBody, id }),
		});
		expect(response.status).toBe(200);
		await response.text();
	}
	expect(turns.map(({ binding, scope }) => ({ binding, scope }))).toEqual([
		{
			binding: {
				userId: "member-1",
				conversationId: "conversation-1",
				turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			},
			scope: { type: "general" },
		},
		{
			binding: {
				userId: "member-1",
				conversationId: "conversation-2",
				turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			},
			scope: { type: "collection", collectionId: "coll-7" },
		},
	]);
	expect(turns[0]?.binding.turnId).not.toBe(turns[1]?.binding.turnId);
	expect(turns[0]?.audit).toBe(documentAccessLog);
	expect(turns[0]?.logger).toBe(logger as never);
});

it("forwards the stream unchanged: reasoning, sandbox-executed built-in parts, and document-tool parts reach the client as emitted", async () => {
	const { factory, fake } = fakeAgent();
	const parts = [
		{ type: "reasoning-start", id: "r1" },
		{ type: "reasoning-delta", id: "r1", delta: "thinking" },
		{ type: "reasoning-end", id: "r1" },
		{
			type: "tool-input-available",
			toolCallId: "w1",
			toolName: "write",
			providerExecuted: true,
			input: { file_path: "notes.md", content: "pelican" },
		},
		{
			type: "tool-input-available",
			toolCallId: "s1",
			toolName: "SearchDocuments",
			providerExecuted: false,
			input: { query: "pelican" },
		},
		{
			type: "tool-output-available",
			toolCallId: "s1",
			output: {
				error: "Error: SearchDocuments failed: document search failed",
			},
		},
		{
			type: "tool-input-available",
			toolCallId: "c1",
			toolName: "compaction",
			dynamic: true,
			providerExecuted: true,
			input: {},
		},
		{
			type: "tool-input-available",
			toolCallId: "f1",
			toolName: "fileChange",
			dynamic: true,
			providerExecuted: true,
			input: { path: "notes.md" },
		},
		{ type: "text-delta", id: "t1", delta: "Saved; I cannot run commands." },
	];
	fake.stream = async () => ({
		toUIMessageStreamResponse: () =>
			streamResponse(
				`${parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("")}data: [DONE]\n\n`,
			),
	});
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
	});
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(streamParts(await response.text())).toEqual(parts);
});

it("resumes the Conversation's session from the stored pointer", async () => {
	const { factory, events } = fakeAgent();
	const pointer = { type: "resume-session", data: { from: "before" } };
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
		harnessResumeStateStore: fakeResumeStore(pointer).store,
	});
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(response.status).toBe(200);
	expect(events[0]).toEqual({
		createSession: { sessionId: "conversation-1", resumeFrom: pointer },
	});
	expect(await response.text()).not.toContain("before");
});

it("starts a fresh session for the same id and logs when resuming throws", async () => {
	const { factory, events, fake } = fakeAgent();
	const createSession = fake.createSession;
	fake.createSession = async (options) => {
		if (options.resumeFrom) throw new Error("snapshot expired");
		return createSession(options);
	};
	const { store, saved } = fakeResumeStore({
		type: "resume-session",
		data: {},
	});
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
		harnessResumeStateStore: store,
	});
	logged.length = 0;
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(uiMessageStream);
	expect(events[0]).toEqual({ createSession: { sessionId: "conversation-1" } });
	expect(logged).toEqual([
		{
			level: "warn",
			obj: { err: expect.any(Error), conversationId: "conversation-1" },
			msg: "harness session resume failed; starting a fresh session",
		},
	]);
	// The stale pointer is replaced by the fresh session's.
	expect(saved.map((s) => s.state)).toEqual([stoppedState]);
});

it("keeps the previous resume pointer when a stopped turn was still running, so the Conversation answers the next message", async () => {
	const { factory, fake } = fakeAgent();
	// What `stop()` returns when the framework still considers the turn running —
	// a host tool in flight when the client disconnects. It carries bridge
	// coordinates for a bridge the same call then kills.
	const suspendedState = {
		type: "resume-session",
		data: { bridge: "dead" },
		continueFrom: { type: "continue-turn", data: { bridge: "dead" } },
	};
	let resumedSuspended = false;
	fake.createSession = async ({ resumeFrom }) => {
		// Mirrors the framework: creating a session from a pointer that carries
		// `continueFrom` succeeds and yields a *suspended* session.
		resumedSuspended = resumeFrom === suspendedState;
		return { stop: async () => suspendedState };
	};
	fake.stream = async () => {
		// ...and a suspended session refuses the next prompt, which is the 500.
		if (resumedSuspended) throw new Error("turn is not promptable");
		return { toUIMessageStreamResponse: () => streamResponse(uiMessageStream) };
	};
	const { store, saved } = fakeResumeStore();
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
		harnessResumeStateStore: store,
	});
	const post = () =>
		app.request("/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});

	// First turn: the client stops it while a document tool is still running.
	const first = await post();
	expect(first.status).toBe(200);
	await first.body?.cancel();

	// Second turn on the same Conversation: answers instead of 500ing.
	const second = await post();
	expect(second.status).toBe(200);
	expect(await second.text()).toBe(uiMessageStream);
	expect(saved).toEqual([]);
});

it("stops the session when the client cancels the stream", async () => {
	const { factory, events } = fakeAgent();
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
	});
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(events).not.toContain("stop");
	await response.body?.cancel();
	expect(events.at(-1)).toBe("stop");
});

it("passes the request's own abort signal to the turn", async () => {
	const { factory, events } = fakeAgent();
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
	});
	const controller = new AbortController();
	const response = await app.request(
		new Request("http://localhost/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: controller.signal,
		}),
	);
	const streamEvent = events[1] as { stream: { abortSignal?: AbortSignal } };
	expect(streamEvent.stream.abortSignal).toBe(controller.signal);
	await response.body?.cancel();
});

it("ends an aborted turn cleanly with the abort part and still stops the session", async () => {
	const { factory, events, fake } = fakeAgent();
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
		createHarnessChatAgent: factory,
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
	expect(events.at(-1)).toBe("stop");
});

it("stops the session and logs when the turn fails to start", async () => {
	const { factory, events, fake } = fakeAgent();
	fake.stream = async () => {
		throw new Error("bridge unavailable");
	};
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
	});
	logged.length = 0;
	const response = await app.request("/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
	});
	expect(response.status).toBe(500);
	expect(await response.text()).not.toContain("bridge unavailable");
	expect(events.at(-1)).toBe("stop");
	expect(logged).toEqual([
		{
			level: "error",
			obj: { err: expect.any(Error), conversationId: "conversation-1" },
			msg: "harness turn failed to start",
		},
	]);
});

it("hides the cause of a mid-stream failure from the client, logs it, and stops the session", async () => {
	const { factory, events, fake } = fakeAgent();
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
		createHarnessChatAgent: factory,
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
	expect(events.at(-1)).toBe("stop");
	expect(logged).toEqual([
		{
			level: "error",
			obj: { err: expect.any(Error), conversationId: "conversation-1" },
			msg: "harness turn failed while streaming",
		},
	]);
});

it("refuses a second turn on the same Conversation until the first has been stopped", async () => {
	const { factory, events, fake } = fakeAgent();
	// conversation-1's stop() hangs until released; other sessions stop at once.
	const releases: (() => void)[] = [];
	const releaseStop = () => releases.shift()?.();
	let gated = true;
	fake.createSession = async ({ sessionId }) => ({
		stop: async () => {
			if (gated && sessionId === requestBody.id) {
				await new Promise<void>((resolve) => releases.push(resolve));
			}
			events.push("stop");
			return stoppedState;
		},
	});
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
	});
	const post = (id = requestBody.id) =>
		app.request("/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...requestBody, id }),
		});

	const first = await post();
	expect(first.status).toBe(200);
	const second = await post();
	expect(second.status).toBe(409);
	expect(await second.json()).toEqual({
		error: "Conversation has an active response",
	});
	// Other Conversations are unaffected.
	const other = await post("conversation-2");
	expect(other.status).toBe(200);
	await other.body?.cancel();
	// Rejected before any sandbox work: one session per admitted turn.
	expect(
		events.filter((e) => typeof e === "object" && "stream" in (e as object)),
	).toHaveLength(2);

	// Draining the stream is not enough: the slot is held until stop() settles.
	const drained = first.text();
	await Bun.sleep(0);
	expect(releases).toHaveLength(1); // stop() is pending
	expect((await post()).status).toBe(409);
	releaseStop();
	await drained;
	expect(events.at(-1)).toBe("stop");
	gated = false;
	const third = await post();
	expect(third.status).toBe(200);
	await third.body?.cancel();
});

it("releases the slot when the session cannot be created", async () => {
	const { factory, fake } = fakeAgent();
	fake.createSession = async () => {
		throw new Error("sandbox unavailable");
	};
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => true },
		createHarnessChatAgent: factory,
	});
	const post = () =>
		app.request("/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});
	expect((await post()).status).toBe(500);
	expect((await post()).status).toBe(500);
});

it("rejects invalid and exposure-disabled requests before creating a session", async () => {
	const { factory, events } = fakeAgent();
	const app = makeApp({
		conversationStore: ownedConversation,
		exposureGate: { isAgentEnabled: async () => false },
		createHarnessChatAgent: factory,
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
	[
		{ ...conversationRow, archivedAt: new Date() },
		409,
		"Conversation is archived",
	],
] as const)("rejects a missing or archived Conversation before creating a session", async (conversation, status, error) => {
	const { factory, events } = fakeAgent();
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
		createHarnessChatAgent: factory,
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
