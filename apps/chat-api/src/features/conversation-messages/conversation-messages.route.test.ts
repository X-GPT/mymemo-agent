import { describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TurnStatus } from "@mymemo/agent-db/turn-store";
import {
	createInMemoryTurnLiveStreamRelay,
	type TurnLiveStreamRelay,
} from "@mymemo/live-text";
import {
	DefaultChatTransport,
	readUIMessageStream,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type {
	ConversationMessagesPageInput,
	ConversationMessagesStore,
	EnqueueTurnResult,
	TurnRef,
} from "./conversation-messages-store";

const { createApp } = await import("@/app");

const identityHeaders = {
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

function appWith(store: Pick<ConversationMessagesStore, "getPage">) {
	const deps = {
		conversationMessagesStore: store,
		exposureGate: {
			async isAgentEnabled() {
				throw new Error("history reads must not consult exposure");
			},
		},
	} as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as ApiConfig, deps);
}

describe("GET /v2/conversations/:conversationId/messages", () => {
	it("serves the store page with defaulted query, camelCase Turn metadata, and no exposure check", async () => {
		const calls: ConversationMessagesPageInput[] = [];
		const app = appWith({
			async getPage(input) {
				calls.push(input);
				return {
					messages: [
						{
							id: "message-1",
							role: "user",
							parts: [{ type: "text", text: "hi" }],
							metadata: {
								status: "done",
								startedAt: new Date("2026-08-31T01:00:00.000Z"),
								finishedAt: new Date("2026-08-31T01:00:05.000Z"),
							},
						},
						{
							id: "message-2",
							role: "assistant",
							parts: [{ type: "step-start" }, { type: "text", text: "hello" }],
						},
						{
							id: "message-3",
							role: "user",
							parts: [{ type: "text", text: "more" }],
							metadata: { status: "queued", startedAt: null, finishedAt: null },
						},
					],
					nextCursor: 41,
				};
			},
		});

		const response = await app.request(
			"/v2/conversations/conversation-1/messages",
			{ headers: identityHeaders },
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			'{"messages":[' +
				'{"id":"message-1","role":"user","parts":[{"type":"text","text":"hi"}],"metadata":{"status":"done","startedAt":"2026-08-31T01:00:00.000Z","finishedAt":"2026-08-31T01:00:05.000Z"}},' +
				'{"id":"message-2","role":"assistant","parts":[{"type":"step-start"},{"type":"text","text":"hello"}]},' +
				'{"id":"message-3","role":"user","parts":[{"type":"text","text":"more"}],"metadata":{"status":"queued","startedAt":null,"finishedAt":null}}' +
				'],"nextCursor":41}',
		);
		expect(calls).toEqual([
			{
				userId: "member-1",
				conversationId: "conversation-1",
				limit: 50,
				before: null,
			},
		]);
	});

	it("clamps an over-large limit to the cap and forwards the before cursor", async () => {
		const calls: ConversationMessagesPageInput[] = [];
		const app = appWith({
			async getPage(input) {
				calls.push(input);
				return { messages: [], nextCursor: null };
			},
		});

		const response = await app.request(
			"/v2/conversations/conversation-1/messages?limit=1000&before=17",
			{ headers: identityHeaders },
		);

		expect(response.status).toBe(200);
		expect(calls).toEqual([
			{
				userId: "member-1",
				conversationId: "conversation-1",
				limit: 100,
				before: 17,
			},
		]);
	});

	it("rejects malformed paging input before touching the store", async () => {
		const app = appWith({
			async getPage() {
				throw new Error("store must not be reached");
			},
		});

		for (const query of [
			"limit=0",
			"limit=abc",
			"limit=1.5",
			"before=-1",
			"before=abc",
			"unknown=1",
		]) {
			const response = await app.request(
				`/v2/conversations/conversation-1/messages?${query}`,
				{ headers: identityHeaders },
			);
			expect(response.status).toBe(400);
		}
	});

	it("returns owner-safe 404 when the store reports no such Conversation", async () => {
		const app = appWith({
			async getPage() {
				return null;
			},
		});

		const response = await app.request(
			"/v2/conversations/conversation-1/messages",
			{ headers: identityHeaders },
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Conversation not found" });
	});
});

// ---------------------------------------------------------------------------
// POST — submit a UIMessage and stream its own Turn (#667)
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "conversation-1";
const MESSAGES_URL = `/v2/conversations/${CONVERSATION_ID}/messages`;

/** The queue as chat-api sees it: rows keyed by message id, insertion-ordered. */
class FakeTurnStore implements ConversationMessagesStore {
	readonly rows = new Map<string, { status: TurnStatus; parts: unknown }>();
	archived = false;
	exists = true;

	async getPage(): Promise<never> {
		throw new Error("not under test");
	}

	async enqueueTurn(
		input: TurnRef & { parts: unknown },
	): Promise<EnqueueTurnResult> {
		if (!this.exists || input.conversationId !== CONVERSATION_ID) {
			return { outcome: "not_found" };
		}
		if (this.archived) return { outcome: "archived" };
		if (input.messageId.startsWith("assistant-")) {
			return { outcome: "not_a_turn" };
		}
		const existing = this.rows.get(input.messageId);
		if (existing) return { outcome: "duplicate", status: existing.status };
		this.rows.set(input.messageId, { status: "queued", parts: input.parts });
		return { outcome: "queued" };
	}

	async getTurnStatus(ref: TurnRef): Promise<TurnStatus | null> {
		return this.rows.get(ref.messageId)?.status ?? null;
	}

	/** The In-VM server's claim: lowest queued row while nothing is processing. */
	claimNext(): string | null {
		for (const row of this.rows.values()) {
			if (row.status === "processing") return null;
		}
		for (const [id, row] of this.rows) {
			if (row.status === "queued") {
				row.status = "processing";
				return id;
			}
		}
		return null;
	}
}

function scriptedChunks(turnId: string): UIMessageChunk[] {
	return [
		{ type: "start", messageId: `assistant-${turnId}` },
		{ type: "start-step" },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: `hello from ${turnId}` },
		{ type: "text-end", id: "t1" },
		{ type: "finish-step" },
	];
}

/**
 * A stand-in for the In-VM server's drain loop: a nudge drains queued Turns
 * in order, publishing each Turn's chunks on its own channel with the real
 * commit-before-publish ordering (status flips before the terminal chunk).
 */
function fakeInVmServer(
	relay: TurnLiveStreamRelay,
	store: FakeTurnStore,
	options: { chunkDelayMs?: number; sync?: boolean } = {},
) {
	const served: string[] = [];
	let draining: Promise<void> | null = null;
	const drain = async () => {
		let turnId = store.claimNext();
		while (turnId) {
			const publisher = relay.openPublisher({
				conversationId: CONVERSATION_ID,
				messageId: turnId,
			});
			for (const chunk of scriptedChunks(turnId)) {
				await publisher.publish(chunk);
				if (options.chunkDelayMs) await delay(options.chunkDelayMs);
			}
			const row = store.rows.get(turnId);
			if (row) row.status = "done";
			await publisher.publish({ type: "finish" });
			await publisher.close();
			served.push(turnId);
			turnId = store.claimNext();
		}
	};
	return {
		served,
		nudges: 0,
		async nudge() {
			this.nudges += 1;
			if (options.sync) {
				await drain();
				return;
			}
			if (!draining) {
				draining = drain().finally(() => {
					draining = null;
				});
			}
		},
		async idle() {
			while (draining) await draining;
		},
	};
}

function submitApp(
	overrides: Partial<AppDeps> & {
		store?: FakeTurnStore;
		vm?: Parameters<typeof fakeInVmServer>[2];
	} = {},
) {
	const store = overrides.store ?? new FakeTurnStore();
	const relay = createInMemoryTurnLiveStreamRelay();
	const vm = fakeInVmServer(relay, store, overrides.vm);
	const deps = {
		conversationMessagesStore: store,
		turnLiveStreamRelay: relay,
		nudgeInVmServer: () => vm.nudge(),
		exposureGate: { isAgentEnabled: async () => true },
		...overrides,
	} as unknown as AppDeps;
	const app = createApp({ logLevel: "silent" } as ApiConfig, deps);
	return { app, store, relay, vm };
}

function userMessage(id: string, text = `message ${id}`): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] };
}

function submitBody(message: UIMessage, id = CONVERSATION_ID) {
	return {
		method: "POST",
		headers: { ...identityHeaders, "content-type": "application/json" },
		body: JSON.stringify({
			id,
			trigger: "submit-message",
			messages: [message],
		}),
	};
}

/** Every SSE `data:` payload in order, `[DONE]` included, plus the pings. */
function parseSse(text: string): { data: string[]; pings: number } {
	const frames = text.split("\n\n").filter((frame) => frame.length > 0);
	return {
		data: frames
			.filter((frame) => frame.startsWith("data: "))
			.map((frame) => frame.slice("data: ".length)),
		pings: frames.filter((frame) => frame === ": ping").length,
	};
}

function chunksOf(data: string[]): unknown[] {
	return data.filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
}

describe("POST /v2/conversations/:conversationId/messages", () => {
	it("persists the message queued, streams its Turn as the stock UI Message Stream, and ends with [DONE]", async () => {
		const { app, store, vm } = submitApp();

		const response = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1", "hi")),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		const { data } = parseSse(await response.text());
		expect(chunksOf(data)).toEqual([
			...scriptedChunks("turn-1"),
			{ type: "finish" },
		]);
		expect(data.at(-1)).toBe("[DONE]");
		expect(store.rows.get("turn-1")).toEqual({
			status: "done",
			parts: [{ type: "text", text: "hi" }],
		});
		expect(vm.nudges).toBe(1);
	});

	it("is consumable by the stock DefaultChatTransport as one assistant message", async () => {
		const { app } = submitApp();
		const transport = new DefaultChatTransport({
			api: MESSAGES_URL,
			headers: identityHeaders,
			// Bun's `fetch` type also carries `preconnect`; the transport only calls.
			fetch: ((input, init) => app.request(input, init)) as typeof fetch,
		});

		const stream = await transport.sendMessages({
			chatId: CONVERSATION_ID,
			messages: [userMessage("turn-1")],
			trigger: "submit-message",
			messageId: undefined,
			abortSignal: undefined,
		});
		let last: UIMessage | undefined;
		for await (const message of readUIMessageStream({ stream })) {
			last = message;
		}

		expect(last).toEqual({
			id: "assistant-turn-1",
			role: "assistant",
			parts: [
				{ type: "step-start" },
				{ type: "text", text: "hello from turn-1", state: "done" },
			],
		});
	});

	it("subscribes before nudging, so chunks published during the nudge itself are not lost", async () => {
		const { app } = submitApp({ vm: { sync: true } });

		const response = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1")),
		);

		expect(response.status).toBe(200);
		const { data } = parseSse(await response.text());
		expect(chunksOf(data)).toEqual([
			...scriptedChunks("turn-1"),
			{ type: "finish" },
		]);
	});

	it("two rapid POSTs: no 409; the second holds with silent keepalives, then streams only its own Turn", async () => {
		// The first Turn outlasts one keepalive interval.
		const { app, vm } = submitApp({ vm: { chunkDelayMs: 900 } });

		const first = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1")),
		);
		const second = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-2")),
		);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);

		const [firstSse, secondSse] = await Promise.all([
			first.text().then(parseSse),
			second.text().then(parseSse),
		]);
		expect(chunksOf(firstSse.data)).toEqual([
			...scriptedChunks("turn-1"),
			{ type: "finish" },
		]);
		expect(chunksOf(secondSse.data)).toEqual([
			...scriptedChunks("turn-2"),
			{ type: "finish" },
		]);
		expect(secondSse.pings).toBeGreaterThanOrEqual(1);
		expect(vm.served).toEqual(["turn-1", "turn-2"]);
	});

	it("duplicate client message id: no second Turn; a terminal Turn answers 410, an in-flight one attaches", async () => {
		const store = new FakeTurnStore();
		store.rows.set("turn-done", { status: "done", parts: [] });
		store.rows.set("turn-live", { status: "processing", parts: [] });
		const { app, relay, vm } = submitApp({ store });

		const ended = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-done")),
		);
		expect(ended.status).toBe(410);
		expect(await ended.json()).toEqual({
			error: "Turn already ended",
			recovery: "history",
		});
		expect(vm.nudges).toBe(0);

		const attached = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-live")),
		);
		expect(attached.status).toBe(200);
		// The In-VM server is mid-Turn; only what it publishes from now on
		// arrives (no backlog), and the nudge was a harmless no-op.
		const publisher = relay.openPublisher({
			conversationId: CONVERSATION_ID,
			messageId: "turn-live",
		});
		await publisher.publish({ type: "text-delta", id: "t1", delta: "late" });
		const row = store.rows.get("turn-live");
		if (row) row.status = "done";
		await publisher.publish({ type: "finish" });
		await publisher.close();
		const { data } = parseSse(await attached.text());
		expect(chunksOf(data)).toEqual([
			{ type: "text-delta", id: "t1", delta: "late" },
			{ type: "finish" },
		]);
		expect(store.rows.size).toBe(2);
		expect(vm.nudges).toBe(1);

		// An id copied from an assistant message in history is a 409, not a 500.
		const taken = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("assistant-turn-done")),
		);
		expect(taken.status).toBe(409);
		expect(await taken.json()).toEqual({
			error: "Message id names an assistant message",
		});
		expect(vm.nudges).toBe(1);
	});

	it("client disconnect mid-stream leaves the Turn running to its Outcome", async () => {
		const { app, store, vm } = submitApp({ vm: { chunkDelayMs: 20 } });
		const client = new AbortController();

		const response = await app.request(MESSAGES_URL, {
			...submitBody(userMessage("turn-1")),
			signal: client.signal,
		});
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no body");
		await reader.read();
		client.abort();
		await reader.cancel();

		await vm.idle();
		expect(store.rows.get("turn-1")?.status).toBe("done");
		expect(vm.served).toEqual(["turn-1"]);
	});

	it("ends a stream whose publisher vanished once the Turn is durably terminal", async () => {
		const store = new FakeTurnStore();
		const { app } = submitApp({
			store,
			// A nudge that never publishes: the VM died after claiming.
			nudgeInVmServer: async () => {
				const row = store.rows.get("turn-1");
				if (row) row.status = "processing";
			},
		});

		const response = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1")),
		);
		expect(response.status).toBe(200);
		// The boot sweep of a restarted VM lands while the client waits.
		const row = store.rows.get("turn-1");
		if (row) row.status = "interrupted";

		const { data, pings } = parseSse(await response.text());
		expect(pings).toBeGreaterThanOrEqual(2);
		expect(data).toEqual(["[DONE]"]);
	});

	it("archived Conversation refuses the message; missing or foreign is 404", async () => {
		const archived = submitApp();
		archived.store.archived = true;
		const refused = await archived.app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1")),
		);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "Conversation is archived" });
		expect(archived.vm.nudges).toBe(0);

		const missing = submitApp();
		missing.store.exists = false;
		const notFound = await missing.app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1")),
		);
		expect(notFound.status).toBe(404);
	});

	it("enforces the exposure gate on submission before any write", async () => {
		const { app, store, vm } = submitApp({
			exposureGate: { isAgentEnabled: async () => false },
		});

		const response = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1")),
		);

		expect(response.status).toBe(403);
		expect(store.rows.size).toBe(0);
		expect(vm.nudges).toBe(0);
	});

	it("answers 503 without writing while no In-VM server is configured", async () => {
		const { app, store } = submitApp({ nudgeInVmServer: undefined });

		const response = await app.request(
			MESSAGES_URL,
			submitBody(userMessage("turn-1")),
		);

		expect(response.status).toBe(503);
		expect(store.rows.size).toBe(0);
	});

	it("rejects bodies that are not one submitted user text UIMessage for this Conversation", async () => {
		const { app, store } = submitApp();
		const bad = [
			submitBody(userMessage("turn-1"), "conversation-2"),
			{
				...submitBody(userMessage("turn-1")),
				body: JSON.stringify({
					id: CONVERSATION_ID,
					trigger: "regenerate-message",
					messages: [userMessage("turn-1")],
				}),
			},
			submitBody({ id: "turn-1", role: "assistant", parts: [] }),
			submitBody({ id: "turn-1", role: "user", parts: [] }),
			submitBody({
				id: "turn-1",
				role: "user",
				parts: [{ type: "file", url: "x", mediaType: "text/plain" }],
			}),
			submitBody(userMessage("not path safe!")),
			submitBody(userMessage("turn-1", "")),
		];
		for (const request of bad) {
			const response = await app.request(MESSAGES_URL, request);
			expect(response.status).toBe(400);
		}
		expect(store.rows.size).toBe(0);
	});
});
