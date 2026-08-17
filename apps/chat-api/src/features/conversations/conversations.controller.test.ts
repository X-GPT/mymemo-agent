import { describe, expect, it } from "bun:test";
import type { AppDeps } from "@/deps";
import type {
	ConversationCreateInput,
	ConversationRecord,
	ConversationStore,
} from "@/features/conversation-store";
import type { RunStore } from "@/features/run-store";
import { admitAgUiRun, createConversation } from "./conversations.controller";

/** In-memory store capturing every created record. */
function fakeStore() {
	const created: ConversationCreateInput[] = [];
	const store: ConversationStore = {
		async get() {
			return null;
		},
		async list() {
			return { conversations: [], next: null };
		},
		async create(record) {
			created.push(record);
			const now = new Date();
			return {
				...record,
				title: null,
				createdAt: now,
				lastActivityAt: now,
				archivedAt: null,
			};
		},
		async update() {
			return { outcome: "not_found" };
		},
		async deletePermanently() {
			return { outcome: "not_found" };
		},
	};
	return { store, created };
}

const conversation: ConversationRecord = {
	userId: "member-1",
	conversationId: "conv-1",
	executionRuntime: "fargate",
	scope: "general",
	collectionId: null,
	summaryId: null,
	title: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
	archivedAt: null,
};

describe("createConversation", () => {
	it("freezes general scope when no ids are given", async () => {
		const { store, created } = fakeStore();
		const result = await createConversation(
			store,
			{ memberCode: "member-1", partnerCode: "partner-1" },
			{},
			"fargate",
		);

		expect(result.scope).toBe("general");
		expect(created[0]?.conversationId).toBe(result.conversationId);
		expect(created[0]).toMatchObject({
			userId: "member-1",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
	});

	it("freezes collection scope from collectionId", async () => {
		const { store, created } = fakeStore();
		const result = await createConversation(
			store,
			{ memberCode: "member-1", partnerCode: "partner-1" },
			{ collectionId: " col-9 " },
			"fargate",
		);

		expect(result.scope).toBe("collection");
		expect(created[0]).toMatchObject({
			scope: "collection",
			collectionId: "col-9",
		});
	});

	it("freezes document scope from summaryId, taking precedence over collectionId", async () => {
		const { store, created } = fakeStore();
		const result = await createConversation(
			store,
			{ memberCode: "member-1", partnerCode: "partner-1" },
			{ collectionId: "col-9", summaryId: "sum-3" },
			"fargate",
		);

		expect(result.scope).toBe("document");
		expect(created[0]).toMatchObject({
			scope: "document",
			collectionId: "col-9",
			summaryId: "sum-3",
		});
	});
});

describe("admitAgUiRun", () => {
	it("admits only the final submitted User message against frozen conversation data", async () => {
		const calls: Array<Parameters<RunStore["admitRun"]>[0]> = [];
		const runStore: RunStore = {
			async admitRun(input) {
				calls.push(input);
				return { outcome: "not_found" };
			},
			async getRun() {
				return null;
			},
			async requestInterruption() {
				return { outcome: "not_found" };
			},
		};

		await admitAgUiRun({ runStore } as unknown as AppDeps, {
			conversation,
			input: {
				threadId: "conv-1",
				runId: "run-client-1",
				messages: [
					{ id: "prior", role: "assistant", content: "history" },
					{ id: "submitted-1", role: "user", content: "new work" },
				],
				tools: [],
				context: [],
			},
		});

		expect(calls).toEqual([
			{
				conversation,
				runId: "run-client-1",
				messageId: "submitted-1",
				message: "new work",
			},
		]);
	});
});
