import { describe, expect, it } from "bun:test";
import {
	createLiveTextTelemetry,
	disabledLiveTextSubscriber,
	InMemoryLiveTextTransport,
	type LiveTextSubscriber,
} from "@mymemo/live-text";
import type { ApiConfig } from "@/config/env";
import { runEvents, runs } from "@/db/schema";
import { createTestDatabase } from "@/db/testing";
import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationRef,
	ConversationStore,
} from "@/features/conversation-store";
import { PostgresConversationStore } from "@/features/conversation-store";
import type { ExposureGate } from "@/features/exposure-gate";
import type {
	RunEventReader,
	RunEventRow,
	RunNotifier,
	RunSubscription,
} from "@/features/run-events";
import { DrizzleRunEventReader, RunEventType } from "@/features/run-events";
import {
	ActiveRunExistsError,
	ConversationArchivedError,
	ConversationNotFoundError,
	PostgresRunStore,
	type RunRecord,
	type RunStore,
} from "@/features/run-store";
import type { InternalIdentity } from "./conversations.schema";

const { createApp } = await import("@/app");
const silentLiveTextTelemetry = createLiveTextTelemetry("chat-api", {
	info() {},
	warn() {},
});

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
			const now = new Date();
			const persisted: ConversationRecord = {
				...record,
				title: null,
				createdAt: now,
				lastActivityAt: now,
				archivedAt: null,
			};
			rows.set(`${record.userId}/${record.conversationId}`, persisted);
			created.push(persisted);
			return persisted;
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

function gateThatFailsIfConsulted(): ExposureGate {
	return {
		async isAgentEnabled() {
			throw new Error("exposure gate should not be consulted");
		},
	};
}

function buildApp(
	conversationStore: ConversationStore,
	exposureGate: ExposureGate = recordingGate(true).gate,
	fakeRuns = fakeRunStore(),
	liveTextSubscriber: LiveTextSubscriber = disabledLiveTextSubscriber,
) {
	const deps = {
		config: {},
		conversationStore,
		exposureGate,
		runStore: fakeRuns.runStore,
		runEventReader: fakeRuns.runEventReader,
		runNotifier: fakeRuns.runNotifier,
		liveTextSubscriber,
		liveTextTelemetry: silentLiveTextTelemetry,
	} as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as unknown as ApiConfig, deps);
}

function fakeRunStore() {
	const queued: Array<{
		conversation: ConversationRef;
		message: string;
	}> = [];
	const eventsByRun = new Map<string, RunEventRow[]>();
	const runOwners = new Map<
		string,
		{
			userId: string;
			conversationId: string;
			status: string;
			nextEventSeq?: number;
		}
	>();
	const cancellations: Array<{
		userId: string;
		conversationId: string;
		runId: string;
	}> = [];
	const runStore: RunStore = {
		async createQueuedRun(input) {
			const runId = input.runId ?? `run-${queued.length + 1}`;
			queued.push({
				conversation: input.conversation,
				message: input.message,
			});
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
			const maxSeq = Math.max(
				0,
				...(eventsByRun.get(runId) ?? []).map((event) => event.seq),
			);
			return runRecord({
				runId,
				nextEventSeq: maxSeq + 1,
				...owner,
			});
		},
		async requestCancellation({ userId, conversationId, runId }) {
			cancellations.push({ userId, conversationId, runId });
			const owner = runOwners.get(runId);
			if (
				!owner ||
				owner.userId !== userId ||
				owner.conversationId !== conversationId
			) {
				return { outcome: "not_found" };
			}
			if (owner.status === "queued") {
				owner.status = "canceled";
				return { outcome: "canceled", run: runRecord({ runId, ...owner }) };
			}
			if (owner.status === "running" || owner.status === "cancel_requested") {
				owner.status = "cancel_requested";
				return {
					outcome: "cancel_requested",
					run: runRecord({ runId, ...owner }),
				};
			}
			return {
				outcome: "already_terminal",
				run: runRecord({ runId, ...owner }),
			};
		},
	};
	const runEventReader: RunEventReader = {
		async read(runId, afterSeq, limit) {
			return (eventsByRun.get(runId) ?? [])
				.filter((e) => e.seq > afterSeq)
				.slice(0, limit);
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
	return {
		runStore,
		runEventReader,
		runNotifier,
		queued,
		eventsByRun,
		runOwners,
		cancellations,
	};
}

function runRecord(input: {
	runId: string;
	userId: string;
	conversationId: string;
	status: string;
	nextEventSeq?: number;
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
		nextEventSeq: input.nextEventSeq ?? 1,
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

function parseSseFrames(text: string): Array<{
	id?: string;
	event: string;
	data: unknown;
}> {
	return text
		.trim()
		.split("\n\n")
		.filter(Boolean)
		.map((block) => {
			const fields = new Map(
				block.split("\n").map((line) => {
					const separator = line.indexOf(": ");
					return [line.slice(0, separator), line.slice(separator + 2)];
				}),
			);
			const event = fields.get("event");
			const data = fields.get("data");
			if (!event || !data) throw new Error(`malformed SSE block: ${block}`);
			const id = fields.get("id");
			return {
				...(id ? { id } : {}),
				event,
				data: JSON.parse(data),
			};
		});
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
		title: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
		archivedAt: null,
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

	it("streams two sequential Assistant previews through exact commits and done at the route boundary", async () => {
		const tdb = await createTestDatabase();
		const conversationStore = new PostgresConversationStore(tdb.db);
		await conversationStore.create(existing);
		const liveText = new InMemoryLiveTextTransport();
		const order: string[] = [];
		const durableRunStore = new PostgresRunStore(tdb.db);
		const runStore: RunStore = {
			...durableRunStore,
			async createQueuedRun(input) {
				order.push("admit");
				return durableRunStore.createQueuedRun(input);
			},
			getRun: (input) => durableRunStore.getRun(input),
			requestCancellation: (input) =>
				durableRunStore.requestCancellation(input),
		};
		const subscriber: LiveTextSubscriber = {
			async subscribe(runId) {
				order.push("subscribe");
				const subscription = await liveText.subscribe(runId);
				await liveText.publish({
					runId,
					messageId: "message-1",
					deltaIndex: 0,
					text: "hel",
				});
				await liveText.publish({
					runId,
					messageId: "message-1",
					deltaIndex: 1,
					text: "lo",
				});
				await liveText.publish({
					runId,
					messageId: "message-2",
					deltaIndex: 0,
					text: "again",
				});
				return subscription;
			},
		};
		const durableReader = new DrizzleRunEventReader(tdb.db);
		let resolveFirstRead: () => void = () => {};
		const firstRead = new Promise<void>((resolve) => {
			resolveFirstRead = resolve;
		});
		let releaseLaterReads: () => void = () => {};
		const laterReadsReleased = new Promise<void>((resolve) => {
			releaseLaterReads = resolve;
		});
		let readCount = 0;
		const runEventReader: RunEventReader = {
			async read(runId, afterSeq, limit) {
				const currentRead = ++readCount;
				if (currentRead > 1) await laterReadsReleased;
				const rows = await durableReader.read(runId, afterSeq, limit);
				if (currentRead === 1) resolveFirstRead();
				return rows;
			},
		};

		const deps = {
			config: {},
			conversationStore,
			exposureGate: recordingGate(true).gate,
			runStore,
			runEventReader,
			runNotifier: fakeRunStore().runNotifier,
			liveTextSubscriber: subscriber,
			liveTextTelemetry: silentLiveTextTelemetry,
		} as unknown as AppDeps;
		const res = await createApp(
			{ logLevel: "silent" } as unknown as ApiConfig,
			deps,
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: userMessage,
		});
		try {
			const admittedRuns = await tdb.db
				.select({ runId: runs.runId })
				.from(runs);
			const admittedRunId = admittedRuns[0]?.runId;
			if (!admittedRunId) throw new Error("route did not admit a Run");
			expect(admittedRunId).toMatch(/^[0-9a-f-]{36}$/);
			let resolvePreview: () => void = () => {};
			const previewReceived = new Promise<void>((resolve) => {
				resolvePreview = resolve;
			});
			const body = (async () => {
				const reader = res.body?.getReader();
				if (!reader) return "";
				const decoder = new TextDecoder();
				let text = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return text;
					text += decoder.decode(value);
					if (text.includes("text_delta")) resolvePreview();
				}
			})();
			await firstRead;
			await previewReceived;
			await tdb.db.insert(runEvents).values([
				{
					runId: admittedRunId,
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "hello" },
				},
				{
					runId: admittedRunId,
					seq: 3,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-2", text: "again" },
				},
				{
					runId: admittedRunId,
					seq: 4,
					type: RunEventType.Done,
					payload: {},
				},
			]);
			releaseLaterReads();

			const frames = parseSseFrames(await body);
			expect(order).toEqual(["subscribe", "admit"]);
			expect(frames).toEqual([
				{
					event: "conversation_id",
					data: { type: "conversation_id", conversationId: "conv-1" },
				},
				{
					id: "1",
					event: "run_id",
					data: { type: "run_id", runId: admittedRunId },
				},
				{
					event: "text_delta",
					data: {
						type: "text_delta",
						messageId: "message-1",
						deltaIndex: 0,
						text: "hel",
					},
				},
				{
					event: "text_delta",
					data: {
						type: "text_delta",
						messageId: "message-1",
						deltaIndex: 1,
						text: "lo",
					},
				},
				{
					event: "text_delta",
					data: {
						type: "text_delta",
						messageId: "message-2",
						deltaIndex: 0,
						text: "again",
					},
				},
				{
					id: "2",
					event: "text_commit",
					data: {
						type: "text_commit",
						messageId: "message-1",
						text: "hello",
					},
				},
				{
					id: "3",
					event: "text_commit",
					data: {
						type: "text_commit",
						messageId: "message-2",
						text: "again",
					},
				},
				{ id: "4", event: "done", data: { type: "done" } },
			]);
		} finally {
			releaseLaterReads();
			await tdb.close();
		}
	});

	it("closes the prepared Live subscription when admission conflicts", async () => {
		const { store } = fakeStore([existing]);
		let closes = 0;
		const subscriber: LiveTextSubscriber = {
			async subscribe() {
				return {
					readAvailable: () => [],
					readDroppedMessages: () => ({
						type: "message_ids",
						messageIds: [],
					}),
					waitForMessage: async () => false,
					close: async () => {
						closes++;
					},
				};
			},
		};
		const runStore: RunStore = {
			async createQueuedRun() {
				throw new ActiveRunExistsError();
			},
			async getRun() {
				return null;
			},
			async requestCancellation() {
				return { outcome: "not_found" };
			},
		};

		const res = await buildApp(
			store,
			recordingGate(true).gate,
			{ ...fakeRunStore(), runStore },
			subscriber,
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: userMessage,
		});

		expect(res.status).toBe(409);
		expect(closes).toBe(1);
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
			async requestCancellation() {
				return { outcome: "not_found" };
			},
		};
		const res = await buildApp(store, recordingGate(true).gate, {
			...fakeRunStore(),
			runStore,
		}).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: userMessage,
		});

		expect(res.status).toBe(409);
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
	});

	it("returns 409 when the conversation is archived during admission", async () => {
		const { store } = fakeStore([existing]);
		const runStore: RunStore = {
			async createQueuedRun() {
				throw new ConversationArchivedError();
			},
			async getRun() {
				return null;
			},
			async requestCancellation() {
				return { outcome: "not_found" };
			},
		};
		const res = await buildApp(store, recordingGate(true).gate, {
			...fakeRunStore(),
			runStore,
		}).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: userMessage,
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "Conversation is archived" });
	});

	it("returns 404 when the conversation is deleted during admission", async () => {
		const { store } = fakeStore([existing]);
		const runStore: RunStore = {
			async createQueuedRun() {
				throw new ConversationNotFoundError();
			},
			async getRun() {
				return null;
			},
			async requestCancellation() {
				return { outcome: "not_found" };
			},
		};
		const res = await buildApp(store, recordingGate(true).gate, {
			...fakeRunStore(),
			runStore,
		}).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: userMessage,
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Conversation not found" });
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
				body: JSON.stringify({ type: "user.tool_confirmation" }),
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

describe("POST /v1/conversations/:id/events — user.interrupt", () => {
	const existing: ConversationRecord = {
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

	function interrupt(runId: string) {
		return JSON.stringify({ type: "user.interrupt", runId });
	}

	it("cancels a queued run with JSON, never opening SSE", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "queued",
		});

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("run-1"),
		});

		expect(res.status).toBe(202);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
		expect(await res.json()).toEqual({ runId: "run-1", status: "canceled" });
		// A control event never creates a new run, and the cancellation lookup is
		// scoped to the owning member's conversation.
		expect(fakeRuns.queued).toHaveLength(0);
		expect(fakeRuns.cancellations).toEqual([
			{ userId: "member-1", conversationId: "conv-1", runId: "run-1" },
		]);
	});

	it("moves a running run to cancel_requested", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
		});

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("run-1"),
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({
			runId: "run-1",
			status: "cancel_requested",
		});
	});

	it("returns 409 with the current status for a terminal run", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "done",
		});

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("run-1"),
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ runId: "run-1", status: "done" });
	});

	it("returns 404 for a missing or foreign run", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "other-member",
			conversationId: "conv-1",
			status: "running",
		});

		const app = buildApp(store, gateThatFailsIfConsulted(), fakeRuns);
		const missing = await app.request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("run-ghost"),
		});
		expect(missing.status).toBe(404);

		const foreign = await app.request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("run-1"),
		});
		expect(foreign.status).toBe(404);
	});

	it("returns 404 for a missing conversation without consulting the gate", async () => {
		const res = await buildApp(
			fakeStore().store,
			gateThatFailsIfConsulted(),
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("run-1"),
		});
		expect(res.status).toBe(404);
	});

	it("does not depend on the new-work exposure gate", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "queued",
		});

		// A gated-off user can still interrupt an existing owned run.
		const res = await buildApp(
			store,
			recordingGate(false).gate,
			fakeRuns,
		).request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("run-1"),
		});
		expect(res.status).toBe(202);
	});

	it("rejects a missing or path-unsafe runId with 400", async () => {
		const { store } = fakeStore([existing]);
		const app = buildApp(store);

		const missing = await app.request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify({ type: "user.interrupt" }),
		});
		expect(missing.status).toBe(400);

		const unsafe = await app.request("/v1/conversations/conv-1/events", {
			method: "POST",
			headers: identityHeaders,
			body: interrupt("../escape"),
		});
		expect(unsafe.status).toBe(400);
	});
});

describe("GET /v1/conversations/:id/runs/:runId/events", () => {
	const existing: ConversationRecord = {
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

	it("validates identity headers before reconnecting", async () => {
		const { store } = fakeStore([existing]);
		const res = await buildApp(store).request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ method: "GET" },
		);

		expect(res.status).toBe(401);
	});

	it("returns 404 for a missing or foreign conversation before opening the stream", async () => {
		const missing = await buildApp(fakeStore().store).request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ method: "GET", headers: identityHeaders },
		);
		expect(missing.status).toBe(404);
		expect(missing.headers.get("content-type")).not.toContain(
			"text/event-stream",
		);

		const { store } = fakeStore([existing]);
		const foreign = await buildApp(store).request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{
				method: "GET",
				headers: { ...identityHeaders, "x-member-code": "intruder" },
			},
		);
		expect(foreign.status).toBe(404);
		expect(foreign.headers.get("content-type")).not.toContain(
			"text/event-stream",
		);
	});

	it("returns 404 for a missing run before opening the stream", async () => {
		const { store } = fakeStore([existing]);
		const res = await buildApp(store).request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ method: "GET", headers: identityHeaders },
		);

		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
	});

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
				payload: { messageId: "message-1", text: "hello" },
			},
			{ seq: 3, type: RunEventType.Done, payload: {} },
		]);

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "1" },
		});

		expect(res.status).toBe(200);
		const text = await readSseUntil(
			res,
			(chunk) => chunk.includes("text_commit") && chunk.includes("done"),
		);
		expect(text).toContain("event: text_commit");
		expect(text).toContain("id: 2");
		expect(text).toContain("message-1");
		expect(text).toContain("hello");
		expect(text).not.toContain("text_delta");
		expect(text).not.toContain("conversation_id");
		expect(queued).toHaveLength(0);
	});

	it("suppresses a mid-message reconnect preview but accepts the next complete message", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const { eventsByRun, runOwners } = fakeRuns;
		runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
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
				payload: { messageId: "message-1", text: "complete first" },
			},
			{
				seq: 3,
				type: RunEventType.AssistantText,
				payload: { messageId: "message-2", text: "complete second" },
			},
			{ seq: 4, type: RunEventType.Done, payload: {} },
		]);
		let reads = 0;
		const runEventReader: RunEventReader = {
			async read(runId, afterSeq, limit) {
				reads++;
				if (reads === 1) return [];
				return (eventsByRun.get(runId) ?? [])
					.filter((event) => event.seq > afterSeq)
					.slice(0, limit);
			},
		};
		const liveText = new InMemoryLiveTextTransport();
		const subscriber: LiveTextSubscriber = {
			async subscribe(runId) {
				const subscription = await liveText.subscribe(runId);
				await liveText.publish({
					runId,
					messageId: "message-1",
					deltaIndex: 5,
					text: "suffix must be suppressed",
				});
				await liveText.publish({
					runId,
					messageId: "message-2",
					deltaIndex: 0,
					text: "complete second",
				});
				return subscription;
			},
		};

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			{ ...fakeRuns, runEventReader },
			subscriber,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "1" },
		});

		expect(res.status).toBe(200);
		const frames = parseSseFrames(await res.text());
		expect(frames).toEqual([
			{
				event: "text_delta",
				data: {
					type: "text_delta",
					messageId: "message-2",
					deltaIndex: 0,
					text: "complete second",
				},
			},
			{
				id: "2",
				event: "text_commit",
				data: {
					type: "text_commit",
					messageId: "message-1",
					text: "complete first",
				},
			},
			{
				id: "3",
				event: "text_commit",
				data: {
					type: "text_commit",
					messageId: "message-2",
					text: "complete second",
				},
			},
			{ id: "4", event: "done", data: { type: "done" } },
		]);
		expect(JSON.stringify(frames)).not.toContain("suffix must be suppressed");
	});

	it("streams a terminal historical run to completion and closes", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const { eventsByRun, runOwners } = fakeRuns;
		runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "done",
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
				payload: { messageId: "message-1", text: "finished" },
			},
			{ seq: 3, type: RunEventType.Done, payload: {} },
		]);

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "1" },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("event: text_commit");
		expect(text).toContain("id: 2");
		expect(text).toContain("message-1");
		expect(text).toContain("finished");
		expect(text).toContain("done");
		expect(text).not.toContain("text_delta");
	});

	it("returns 204 when reconnecting after a terminal event", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const { eventsByRun, runOwners } = fakeRuns;
		runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "done",
		});
		eventsByRun.set("run-1", [
			{
				seq: 1,
				type: RunEventType.Started,
				payload: { conversationId: "conv-1", runId: "run-1" },
			},
			{ seq: 2, type: RunEventType.Done, payload: {} },
		]);

		const res = await buildApp(
			store,
			recordingGate(false).gate,
			fakeRuns,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "2" },
		});

		expect(res.status).toBe(204);
		expect(res.headers.get("content-type") ?? "").not.toContain(
			"text/event-stream",
		);
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
		title: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
		archivedAt: null,
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
