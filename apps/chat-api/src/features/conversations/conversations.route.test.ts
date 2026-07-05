import { describe, expect, it } from "bun:test";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationStore,
} from "@/features/conversation-store";
import type { ExposureGate } from "@/features/exposure-gate";
import { RunEventType } from "@/features/run-events";
import type { RunEventReader, RunEventRow } from "@/features/run-events";
import type { RunNotifier, RunSubscription } from "@/features/run-events";
import {
	ActiveRunExistsError,
	type RunRecord,
	type RunStore,
} from "@/features/run-store";
import type { InternalIdentity } from "./conversations.schema";

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
	fakeRuns = fakeRunStore(),
) {
	const deps = {
		config: {},
		conversationStore,
		exposureGate,
		runStore: fakeRuns.runStore,
		runEventReader: fakeRuns.runEventReader,
		runNotifier: fakeRuns.runNotifier,
	} as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as unknown as ApiConfig, deps);
}

function fakeRunStore() {
	const queued: Array<{ conversation: ConversationRecord; message: string }> =
		[];
	const eventsByRun = new Map<string, RunEventRow[]>();
	const runOwners = new Map<
		string,
		{ userId: string; conversationId: string; status: string }
	>();
	const runStore: RunStore = {
		async createQueuedRun(input) {
			const runId = `run-${queued.length + 1}`;
			queued.push(input);
			runOwners.set(runId, {
				userId: input.conversation.userId,
				conversationId: input.conversation.conversationId,
				status: "queued",
			});
			eventsByRun.set(runId, [
				{
					seq: 1,
					type: RunEventType.Started,
					payload: {
						conversationId: input.conversation.conversationId,
						runId,
					},
				},
				{ seq: 2, type: RunEventType.Done, payload: {} },
			]);
			return { runId };
		},
		async getRun({ userId, conversationId, runId }) {
			const owner = runOwners.get(runId);
			if (
				!owner ||
				owner.userId !== userId ||
				owner.conversationId !== conversationId
			) {
				return null;
			}
			return runRecord({ runId, ...owner });
		},
	};
	const runEventReader: RunEventReader = {
		async read(runId, afterSeq) {
			return (eventsByRun.get(runId) ?? []).filter((e) => e.seq > afterSeq);
		},
	};
	const runNotifier: RunNotifier = {
		async subscribe(): Promise<RunSubscription> {
			return {
				async waitForWakeup() {},
				async close() {},
			};
		},
	};
	return { runStore, runEventReader, runNotifier, queued, eventsByRun, runOwners };
}

function runRecord(input: {
	runId: string;
	userId: string;
	conversationId: string;
	status: string;
}): RunRecord {
	const now = new Date();
	return {
		runId: input.runId,
		userId: input.userId,
		conversationId: input.conversationId,
		status: input.status as RunRecord["status"],
		createdAt: now,
		updatedAt: now,
		lockedBy: null,
		lockedUntil: null,
		heartbeatAt: null,
		cancelRequestedAt: null,
		nextEventSeq: 1,
		terminalAt: null,
	};
}

async function readSseUntil(
	res: Response,
	predicate: (text: string) => boolean,
) {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!predicate(text)) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value);
		}
	} finally {
		await reader.cancel();
	}
	return text;
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

	it("queues and streams the run start for an existing conversation", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const { queued } = fakeRuns;
		const res = await buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: userMessage,
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await readSseUntil(
			res,
			(chunk) => chunk.includes("conversation_id") && chunk.includes("run_id"),
		);
		expect(text).toContain("conversation_id");
		expect(text).toContain("run_id");
		expect(queued).toEqual([{ conversation: existing, message: "hi" }]);
	});

	it("returns busy backpressure before opening the stream", async () => {
		const { store } = fakeStore([existing]);
		const runStore: RunStore = {
			async createQueuedRun() {
				throw new ActiveRunExistsError();
			},
			async getRun() {
				return null;
			},
		};
		const res = await buildApp(
			store,
			recordingGate(true).gate,
			{ ...fakeRunStore(), runStore },
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: userMessage,
		});

		expect(res.status).toBe(409);
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
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

describe("GET /v1/conversations/:id/runs/:runId/events", () => {
	const existing: ConversationRecord = {
		userId: "member-1",
		conversationId: "conv-1",
		scope: "general",
		collectionId: null,
		summaryId: null,
	};

	it("replays an owned run after Last-Event-ID without creating a new run", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const { queued, eventsByRun, runOwners } = fakeRuns;
		runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "queued",
		});
		eventsByRun.set("run-1", [
			{
				seq: 1,
				type: RunEventType.Started,
				payload: { conversationId: "conv-1", runId: "run-1" },
			},
			{
				seq: 2,
				type: RunEventType.AssistantText,
				payload: { text: "hello" },
			},
			{ seq: 3, type: RunEventType.Done, payload: {} },
		]);

		const res = await buildApp(
			store,
			recordingGate(false).gate,
			fakeRuns,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "1" },
		});

		expect(res.status).toBe(200);
		const text = await readSseUntil(
			res,
			(chunk) => chunk.includes("text_delta") && chunk.includes("done"),
		);
		expect(text).toContain("text_delta");
		expect(text).toContain("hello");
		expect(text).not.toContain("conversation_id");
		expect(queued).toHaveLength(0);
	});

	it("returns 404 for a foreign run before opening the stream", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const { runOwners } = fakeRuns;
		runOwners.set("run-1", {
			userId: "other-member",
			conversationId: "conv-1",
			status: "queued",
		});

		const res = await buildApp(
			store,
			recordingGate(false).gate,
			fakeRuns,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
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
