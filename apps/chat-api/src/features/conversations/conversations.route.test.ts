import { describe, expect, it, mock } from "bun:test";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationStore,
} from "@/features/conversation-store";
import type { ExposureGate } from "@/features/exposure-gate";
import type { InternalIdentity } from "./conversations.schema";

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

/** Gate that records the identity it saw and returns a fixed decision. */
function recordingGate(decision: boolean) {
	const seen: InternalIdentity[] = [];
	const gate: ExposureGate = {
		async isAgentEnabled(identity) {
			seen.push(identity);
			return decision;
		},
	};
	return { gate, seen };
}

function buildApp(
	conversationStore: ConversationStore,
	exposureGate: ExposureGate = recordingGate(true).gate,
) {
	const deps = {
		config: {},
		sandboxProvider: {},
		workspaceStore: { async appendRunEvent() {} },
		conversationStore,
		exposureGate,
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

describe("exposure gate (MYM-46)", () => {
	const existing: ConversationRecord = {
		userId: "member-1",
		conversationId: "conv-1",
		scope: "general",
		collectionId: null,
		summaryId: null,
	};
	const userMessage = JSON.stringify({ type: "user.message", text: "hi" });

	it("allows conversation creation for an enabled identity", async () => {
		const { store } = fakeStore();
		const res = await buildApp(store, recordingGate(true).gate).request(
			"/v1/conversations",
			{
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(201);
	});

	it("denies conversation creation with 403 and writes nothing", async () => {
		const { store, created } = fakeStore();
		const res = await buildApp(store, recordingGate(false).gate).request(
			"/v1/conversations",
			{
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(403);
		expect(created).toHaveLength(0);
	});

	it("denies user.message with 403 before opening the stream", async () => {
		const { store } = fakeStore([existing]);
		const res = await buildApp(store, recordingGate(false).gate).request(
			"/v1/conversations/conv-1/events",
			{ method: "POST", headers: identityHeaders, body: userMessage },
		);
		expect(res.status).toBe(403);
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
	});

	it("returns 404 (not 403) for a missing conversation even when gated, without consulting the gate", async () => {
		const { store } = fakeStore();
		const { gate, seen } = recordingGate(false);
		const res = await buildApp(store, gate).request(
			"/v1/conversations/missing/events",
			{ method: "POST", headers: identityHeaders, body: userMessage },
		);
		// Ownership/existence (404) is resolved before the exposure gate, so a
		// gated user probing a conversation they don't own gets the documented
		// 404 — and the gate is never consulted for it.
		expect(res.status).toBe(404);
		expect(seen).toHaveLength(0);
	});

	it("evaluates the gate from identity headers, not the request body", async () => {
		const { store } = fakeStore();
		const { gate, seen } = recordingGate(true);
		await buildApp(store, gate).request("/v1/conversations", {
			method: "POST",
			headers: identityHeaders,
			// A smuggled identity in the body is rejected by .strict() upstream, but
			// even structurally the gate only ever sees header-derived identity.
			body: JSON.stringify({}),
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			memberCode: "member-1",
			partnerCode: "partner-1",
		});
	});

	it("checks the gate only after identity is valid (401 short-circuits)", async () => {
		const { store } = fakeStore();
		const { gate, seen } = recordingGate(true);
		const res = await buildApp(store, gate).request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(401);
		expect(seen).toHaveLength(0);
	});
});
