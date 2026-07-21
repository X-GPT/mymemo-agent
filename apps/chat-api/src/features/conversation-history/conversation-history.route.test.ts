import { describe, expect, it } from "bun:test";
import { InvalidRunEventError } from "@mymemo/agent-db/run-events";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import {
	type ConversationHistoryStore,
	InvalidConversationHistoryCursorError,
} from "./conversation-history-store";

const { createApp } = await import("@/app");

const identityHeaders = {
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

describe("GET /v1/conversations/:conversationId/history", () => {
	it("returns the owned permanent history envelope without consulting exposure", async () => {
		const calls: unknown[] = [];
		const historyStore: ConversationHistoryStore = {
			async getPage(input) {
				calls.push(input);
				return {
					conversation: {
						conversationId: "conversation-1",
						title: "Quarterly plan",
						scope: "general",
						collectionId: null,
						summaryId: null,
						createdAt: new Date("2026-07-20T01:00:00.000Z"),
						lastActivityAt: new Date("2026-07-20T02:00:00.000Z"),
						archivedAt: null,
					},
					runs: [],
					nextCursor: null,
					activeRun: null,
				};
			},
		};
		const deps = {
			conversationHistoryStore: historyStore,
			exposureGate: {
				async isAgentEnabled() {
					throw new Error("history reads must not consult exposure");
				},
			},
		} as unknown as AppDeps;
		const app = createApp({ logLevel: "silent" } as ApiConfig, deps);

		const response = await app.request(
			"/v1/conversations/conversation-1/history",
			{ headers: identityHeaders },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			conversation: {
				conversationId: "conversation-1",
				title: "Quarterly plan",
				scope: "general",
				collectionId: null,
				summaryId: null,
				createdAt: "2026-07-20T01:00:00.000Z",
				lastActivityAt: "2026-07-20T02:00:00.000Z",
				archivedAt: null,
			},
			runs: [],
			nextCursor: null,
			activeRun: null,
		});
		expect(calls).toEqual([
			{
				userId: "member-1",
				conversationId: "conversation-1",
				limit: 20,
				cursor: null,
			},
		]);
	});

	it("rejects invalid cursors and hides durable-history corruption", async () => {
		const historyStore: ConversationHistoryStore = {
			async getPage({ cursor }) {
				if (cursor === "bad-cursor") {
					throw new InvalidConversationHistoryCursorError("cursor detail");
				}
				throw new InvalidRunEventError("payload detail must stay private");
			},
		};
		const deps = {
			conversationHistoryStore: historyStore,
		} as unknown as AppDeps;
		const app = createApp({ logLevel: "silent" } as ApiConfig, deps);

		const invalidCursor = await app.request(
			"/v1/conversations/conversation-1/history?cursor=bad-cursor",
			{ headers: identityHeaders },
		);
		expect(invalidCursor.status).toBe(400);
		expect(await invalidCursor.json()).toEqual({
			error: "Invalid history cursor",
		});

		const corruption = await app.request(
			"/v1/conversations/conversation-1/history",
			{ headers: identityHeaders },
		);
		expect(corruption.status).toBe(500);
		expect(await corruption.json()).toEqual({
			error: "Conversation history is unavailable",
		});
	});

	it("requires trusted ownership and validates paging before reading history", async () => {
		let calls = 0;
		const historyStore: ConversationHistoryStore = {
			async getPage() {
				calls++;
				return null;
			},
		};
		const deps = {
			conversationHistoryStore: historyStore,
		} as unknown as AppDeps;
		const app = createApp({ logLevel: "silent" } as ApiConfig, deps);

		const missingIdentity = await app.request(
			"/v1/conversations/conversation-1/history",
		);
		expect(missingIdentity.status).toBe(401);
		expect(calls).toBe(0);

		const invalidPaging = await app.request(
			"/v1/conversations/conversation-1/history?limit=0",
			{ headers: identityHeaders },
		);
		expect(invalidPaging.status).toBe(400);
		expect(calls).toBe(0);

		const missingOrForeign = await app.request(
			"/v1/conversations/conversation-1/history",
			{ headers: identityHeaders },
		);
		expect(missingOrForeign.status).toBe(404);
		expect(calls).toBe(1);
	});
});
