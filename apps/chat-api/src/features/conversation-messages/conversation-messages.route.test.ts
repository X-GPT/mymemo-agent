import { describe, expect, it } from "bun:test";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type {
	ConversationMessagesPageInput,
	ConversationMessagesStore,
} from "./conversation-messages-store";

const { createApp } = await import("@/app");

const identityHeaders = {
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

function appWith(store: ConversationMessagesStore) {
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
