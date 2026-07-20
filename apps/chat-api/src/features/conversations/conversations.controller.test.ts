import { describe, expect, it } from "bun:test";
import type { AppDeps } from "@/deps";
import type {
	ConversationCreateInput,
	ConversationRecord,
	ConversationStore,
} from "@/features/conversation-store";
import type { CreateQueuedRunInput, RunStore } from "@/features/run-store";
import {
	createConversation,
	interruptConversationRun,
	queueConversationTurn,
} from "./conversations.controller";

/** In-memory store capturing every created record. */
function fakeStore() {
	const created: ConversationCreateInput[] = [];
	const store: ConversationStore = {
		async get() {
			return null;
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
		);

		expect(result.scope).toBe("document");
		expect(created[0]).toMatchObject({
			scope: "document",
			collectionId: "col-9",
			summaryId: "sum-3",
		});
	});
});

describe("queueConversationTurn", () => {
	it("queues a run with the frozen conversation record and message", async () => {
		const calls: CreateQueuedRunInput[] = [];
		const runStore: RunStore = {
			async createQueuedRun(input) {
				calls.push(input);
				return { runId: "run-1" };
			},
			async getRun() {
				return null;
			},
			async requestCancellation() {
				return { outcome: "not_found" };
			},
		};
		const deps = { runStore } as unknown as AppDeps;

		const result = await queueConversationTurn(deps, {
			conversation,
			message: "hi",
		});

		expect(result).toEqual({ runId: "run-1" });
		expect(calls).toEqual([{ conversation, message: "hi" }]);
	});

	it("does not accept scope from the turn body", async () => {
		const calls: CreateQueuedRunInput[] = [];
		const runStore: RunStore = {
			async createQueuedRun(input) {
				calls.push(input);
				return { runId: "run-1" };
			},
			async getRun() {
				return null;
			},
			async requestCancellation() {
				return { outcome: "not_found" };
			},
		};
		const deps = { runStore } as unknown as AppDeps;
		const docConversation: ConversationRecord = {
			userId: "member-1",
			conversationId: "conv-doc",
			scope: "document",
			collectionId: null,
			summaryId: "sum-7",
			title: null,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
			archivedAt: null,
		};

		await queueConversationTurn(deps, {
			conversation: docConversation,
			message: "hi",
		});

		expect(calls[0]?.conversation).toEqual(docConversation);
	});
});

describe("interruptConversationRun", () => {
	it("scopes the cancellation to the owned conversation record", async () => {
		const calls: Array<{
			userId: string;
			conversationId: string;
			runId: string;
		}> = [];
		const runStore: RunStore = {
			async createQueuedRun() {
				throw new Error("interrupt must not create a run");
			},
			async getRun() {
				return null;
			},
			async requestCancellation(input) {
				calls.push(input);
				return { outcome: "not_found" };
			},
		};
		const deps = { runStore } as unknown as AppDeps;

		const result = await interruptConversationRun(deps, {
			conversation,
			runId: "run-7",
		});

		expect(result).toEqual({ outcome: "not_found" });
		expect(calls).toEqual([
			{ userId: "member-1", conversationId: "conv-1", runId: "run-7" },
		]);
	});
});
