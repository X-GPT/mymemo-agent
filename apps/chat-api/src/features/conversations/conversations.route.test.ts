import { describe, expect, it, mock } from "bun:test";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationStore,
} from "@/features/conversation-store";

// No sandbox is created: orchestration is mocked to drive the stream callbacks.
type RunOpts = {
	onSandboxId: (id: string) => Promise<void>;
	onDaemonStarted: () => Promise<void>;
	onAgentSessionId: (id: string) => Promise<void>;
	onTextDelta: (text: string) => Promise<void>;
};
mock.module("@/features/sandbox-orchestration", () => ({
	runSandboxChat: async (_deps: unknown, opts: RunOpts) => {
		await opts.onSandboxId("sbx-1");
		await opts.onDaemonStarted();
		await opts.onTextDelta("Hello");
		return { status: "completed" };
	},
	ConversationBusyError: class extends Error {},
}));

const { createApp } = await import("@/index");

/** In-memory ConversationStore for the HTTP layer. */
function fakeStore(seed: ConversationRecord[] = []) {
	const rows = new Map<string, ConversationRecord>(
		seed.map((r) => [`${r.userId}/${r.conversationId}`, r]),
	);
	const created: ConversationRecord[] = [];
	const store: ConversationStore = {
		async get({ userId, conversationId }) {
			return rows.get(`${userId}/${conversationId}`) ?? null;
		},
		async create(record) {
			rows.set(`${record.userId}/${record.conversationId}`, record);
			created.push(record);
		},
	};
	return { store, created };
}

function buildApp(conversationStore: ConversationStore) {
	const deps = {
		config: {},
		sandboxProvider: {},
		workspaceStore: { async appendRunEvent() {} },
		conversationStore,
	} as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as unknown as ApiConfig, deps);
}

const identityHeaders = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

describe("POST /v1/conversations", () => {
	it("creates a conversation and returns the id + frozen scope", async () => {
		const { store, created } = fakeStore();
		const app = buildApp(store);

		const res = await app.request("/v1/conversations", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify({ collectionId: "col-1" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			conversationId: string;
			scope: string;
		};
		expect(body.scope).toBe("collection");
		expect(created[0]).toMatchObject({
			userId: "member-1",
			conversationId: body.conversationId,
			scope: "collection",
			collectionId: "col-1",
		});
	});

	it("rejects missing identity headers with 401", async () => {
		const { store } = fakeStore();
		const res = await buildApp(store).request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(401);
	});

	it("rejects an unknown body key with 400", async () => {
		const { store } = fakeStore();
		const res = await buildApp(store).request("/v1/conversations", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify({ memberCode: "smuggled" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /v1/conversations/:id/events", () => {
	const existing: ConversationRecord = {
		userId: "member-1",
		conversationId: "conv-1",
		scope: "general",
		collectionId: null,
		summaryId: null,
	};
	const userMessage = JSON.stringify({ type: "user.message", text: "hi" });

	it("streams the turn for an existing conversation", async () => {
		const { store } = fakeStore([existing]);
		const res = await buildApp(store).request(
			"/v1/conversations/conv-1/events",
			{ method: "POST", headers: identityHeaders, body: userMessage },
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("text_delta");
		expect(text).toContain("done");
	});

	it("returns 404 when the conversation does not exist", async () => {
		const { store } = fakeStore();
		const res = await buildApp(store).request(
			"/v1/conversations/missing/events",
			{ method: "POST", headers: identityHeaders, body: userMessage },
		);
		expect(res.status).toBe(404);
	});

	it("returns 404 when the conversation belongs to another member", async () => {
		const { store } = fakeStore([existing]);
		const res = await buildApp(store).request(
			"/v1/conversations/conv-1/events",
			{
				method: "POST",
				headers: { ...identityHeaders, "x-member-code": "intruder" },
				body: userMessage,
			},
		);
		expect(res.status).toBe(404);
	});

	it("rejects an unknown event type with 400", async () => {
		const { store } = fakeStore([existing]);
		const res = await buildApp(store).request(
			"/v1/conversations/conv-1/events",
			{
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify({ type: "user.interrupt" }),
			},
		);
		expect(res.status).toBe(400);
	});

	it("rejects a path-unsafe conversation id with 400", async () => {
		const { store } = fakeStore([existing]);
		const res = await buildApp(store).request(
			"/v1/conversations/..%2Fescape/events",
			{ method: "POST", headers: identityHeaders, body: userMessage },
		);
		expect(res.status).toBe(400);
	});
});
