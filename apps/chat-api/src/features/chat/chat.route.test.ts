import { beforeEach, describe, expect, it, mock } from "bun:test";

// Importing `@/index` below eagerly evaluates `config/env.ts`, which throws
// when these are unset. The bunfig preload (`test-setup.ts`) covers this when
// tests run from `apps/chat-api`, but not when `bun test` runs from the repo
// root, so set them here too to keep this file self-sufficient.
Bun.env.E2B_API_KEY = Bun.env.E2B_API_KEY ?? "test-e2b-key";
Bun.env.DAEMON_AUTH_TOKEN =
	Bun.env.DAEMON_AUTH_TOKEN ?? "test-daemon-auth-token";
Bun.env.LLM_TOKEN_SECRET = Bun.env.LLM_TOKEN_SECRET ?? "test-llm-token-secret";
Bun.env.GATEWAY_PUBLIC_URL =
	Bun.env.GATEWAY_PUBLIC_URL ?? "https://gateway.test";

// Orchestration is mocked so no E2B sandbox, gateway, database, or provider
// call is made. A mutable holder lets each test swap the run behavior.
type RunOpts = {
	onSandboxId: (id: string) => Promise<void>;
	onAgentSessionId: (id: string) => Promise<void>;
	onTextDelta: (text: string) => Promise<void>;
	onTextEnd: () => Promise<void>;
};

let runSandboxChatImpl: (opts: RunOpts) => Promise<unknown> = async (opts) => {
	await opts.onSandboxId("sbx-test");
	await opts.onAgentSessionId("agent-sess-test");
	await opts.onTextDelta("Hello");
	await opts.onTextEnd();
	return { status: "completed" };
};

class FakeConversationBusyError extends Error {}

mock.module("@/features/sandbox-orchestration", () => ({
	runSandboxChat: (opts: RunOpts) => runSandboxChatImpl(opts),
	ConversationBusyError: FakeConversationBusyError,
}));

const { default: app } = await import("@/index");

const IDENTITY_HEADERS = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

function postChat(body: unknown, headers: Record<string, string> = {}) {
	return app.request("/v1/chat", {
		method: "POST",
		headers: { ...IDENTITY_HEADERS, ...headers },
		body: JSON.stringify(body),
	});
}

interface SSEFrame {
	event: string;
	data: string;
}

function parseSSE(raw: string): SSEFrame[] {
	const frames: SSEFrame[] = [];
	for (const block of raw.split("\n\n")) {
		let event = "";
		let data = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice("event:".length).trim();
			else if (line.startsWith("data:"))
				data = line.slice("data:".length).trim();
		}
		if (event) frames.push({ event, data });
	}
	return frames;
}

describe("POST /v1/chat", () => {
	beforeEach(() => {
		runSandboxChatImpl = async (opts) => {
			await opts.onSandboxId("sbx-test");
			await opts.onAgentSessionId("agent-sess-test");
			await opts.onTextDelta("Hello");
			await opts.onTextEnd();
			return { status: "completed" };
		};
	});

	it("rejects a body containing sessionId with 400", async () => {
		const res = await postChat({ chatContent: "hi", sessionId: "sess-1" });
		expect(res.status).toBe(400);
	});

	it("rejects missing identity headers with 401", async () => {
		const res = await app.request("/v1/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chatContent: "hi" }),
		});
		expect(res.status).toBe(401);
	});

	it("emits the target SSE event vocabulary on the happy path", async () => {
		const res = await postChat({ chatContent: "hi" });
		expect(res.status).toBe(200);
		const frames = parseSSE(await res.text());
		const events = frames.map((f) => f.event).filter((e) => e !== "ping");

		expect(events).toContain("conversation_id");
		expect(events).toContain("run_id");
		expect(events).toContain("agent_session_id");
		expect(events).toContain("sandbox_id");
		expect(events).toContain("text_delta");
		expect(events).toContain("done");
		// The old client-facing vocabulary must be gone.
		expect(events).not.toContain("session_id");
	});

	it("echoes a client-supplied conversationId", async () => {
		const res = await postChat({
			chatContent: "hi",
			conversationId: "conv-xyz",
		});
		const frames = parseSSE(await res.text());
		const convFrame = frames.find((f) => f.event === "conversation_id");
		expect(convFrame).toBeDefined();
		expect(JSON.parse(convFrame!.data).conversationId).toBe("conv-xyz");
	});

	it("generates a conversationId when the client omits it", async () => {
		const res = await postChat({ chatContent: "hi" });
		const frames = parseSSE(await res.text());
		const convFrame = frames.find((f) => f.event === "conversation_id");
		expect(convFrame).toBeDefined();
		const { conversationId } = JSON.parse(convFrame!.data);
		expect(typeof conversationId).toBe("string");
		expect(conversationId.length).toBeGreaterThan(0);
	});

	it("carries a run_id and agent_session_id payload", async () => {
		const res = await postChat({ chatContent: "hi" });
		const frames = parseSSE(await res.text());
		const runFrame = frames.find((f) => f.event === "run_id");
		const agentFrame = frames.find((f) => f.event === "agent_session_id");
		expect(JSON.parse(runFrame!.data).runId.length).toBeGreaterThan(0);
		expect(JSON.parse(agentFrame!.data).agentSessionId).toBe("agent-sess-test");
	});
});
