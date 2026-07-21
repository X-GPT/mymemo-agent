import { describe, expect, it } from "bun:test";
import {
	createLiveTextTelemetry,
	disabledLiveTextSubscriber,
	InMemoryLiveTextTransport,
	LiveStreamStoreError,
	type LiveTextSubscriber,
} from "@mymemo/live-text";
import { eq, sql } from "drizzle-orm";
import type { ApiConfig } from "@/config/env";
import { conversations, runEvents, runs } from "@/db/schema";
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
		async list() {
			return { conversations: [], next: null };
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
	liveStreamReader: unknown = {
		async status() {
			return "missing";
		},
		async *read() {},
	},
) {
	const deps = {
		config: {},
		conversationStore,
		exposureGate,
		runStore: fakeRuns.runStore,
		runEventReader: fakeRuns.runEventReader,
		runNotifier: fakeRuns.runNotifier,
		liveTextSubscriber,
		liveStreamReader,
		liveTextTelemetry: silentLiveTextTelemetry,
	} as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as unknown as ApiConfig, deps);
}

function buildAppWithDurableRunStore(
	conversationStore: ConversationStore,
	runStore: RunStore,
) {
	return buildApp(
		conversationStore,
		recordingGate(true).gate,
		{ ...fakeRunStore(), runStore },
		disabledLiveTextSubscriber,
		{
			async status() {
				return "done";
			},
			async *read() {},
		},
	);
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
			liveStreamFailedAt?: Date | null;
			nextEventSeq?: number;
		}
	>();
	const cancellations: Array<{
		userId: string;
		conversationId: string;
		runId: string;
	}> = [];
	const runStore: RunStore = {
		async admitRun() {
			throw new Error("AG-UI admission is not used by this test");
		},
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
	liveStreamFailedAt?: Date | null;
	nextEventSeq?: number;
}): RunRecord {
	const now = new Date();
	return {
		runId: input.runId,
		userId: input.userId,
		conversationId: input.conversationId,
		normalizedInput: null,
		status: input.status as RunRecord["status"],
		createdAt: now,
		updatedAt: now,
		lockedBy: null,
		lockedUntil: null,
		heartbeatAt: null,
		cancelRequestedAt: null,
		liveStreamFailedAt: input.liveStreamFailedAt ?? null,
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

function agUiRunInput(overrides: Record<string, unknown> = {}) {
	return {
		threadId: "conv-1",
		runId: "client-run-1",
		state: {},
		messages: [
			{ id: "prior-assistant", role: "assistant", content: "prior" },
			{ id: "user-message-1", role: "user", content: "hello" },
		],
		tools: [],
		context: [],
		forwardedProps: {},
		...overrides,
	};
}

function retainedAgUiStream(events: unknown[]) {
	const encoder = new TextEncoder();
	const entries = events.map((event, index) => ({
		cursor: `${index + 1}-0`,
		chunk: encoder.encode(JSON.stringify(event)),
	}));
	return {
		async status() {
			return "done";
		},
		async *read(_runId: string, cursor: string) {
			const start = cursor
				? entries.findIndex((entry) => entry.cursor === cursor) + 1
				: 0;
			for (const entry of entries.slice(start)) yield entry;
		},
	};
}

function parseAgUiSse(text: string): Array<{ id: string; data: unknown }> {
	return text
		.trim()
		.split("\n\n")
		.filter((block) => block.includes("data:"))
		.map((block) => {
			const lines = block.split("\n");
			const id = lines
				.find((line) => line.startsWith("id:"))
				?.slice(3)
				.trim();
			const data = lines
				.find((line) => line.startsWith("data:"))
				?.slice(5)
				.trim();
			if (!id || !data) throw new Error(`malformed AG-UI SSE block: ${block}`);
			return { id, data: JSON.parse(data) };
		});
}

describe("POST /v1/conversations", () => {
	it("creates an empty draft and returns its standard Conversation summary", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			const app = buildApp(store);

			const res = await app.request("/v1/conversations", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify({ collectionId: "col-1" }),
			});

			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				conversationId: string;
				title: string | null;
				scope: string;
				createdAt: string;
				lastActivityAt: string;
				archivedAt: string | null;
			};
			expect(body).toEqual({
				conversationId: body.conversationId,
				title: null,
				scope: "collection",
				createdAt: body.createdAt,
				lastActivityAt: body.createdAt,
				archivedAt: null,
			});
			expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
			expect(
				await store.get({
					userId: "member-1",
					conversationId: body.conversationId,
				}),
			).toMatchObject({ scope: "collection", collectionId: "col-1" });
		} finally {
			await tdb.close();
		}
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

describe("GET /v1/conversations", () => {
	it("pages regular Conversations by activity with a deterministic opaque cursor", async () => {
		const tdb = await createTestDatabase();
		try {
			await tdb.db.insert(conversations).values([
				{
					userId: "member-1",
					conversationId: "conv-a",
					scope: "general",
					title: "Old regular",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					lastActivityAt: new Date("2026-01-02T00:00:00.000Z"),
				},
				{
					userId: "member-1",
					conversationId: "conv-b",
					scope: "general",
					title: "Recent regular B",
					createdAt: new Date("2026-01-02T00:00:00.000Z"),
					lastActivityAt: new Date("2026-01-03T00:00:00.000Z"),
				},
				{
					userId: "member-1",
					conversationId: "conv-c",
					scope: "collection",
					collectionId: "collection-1",
					title: "Recent regular C",
					createdAt: new Date("2026-01-03T00:00:00.000Z"),
					lastActivityAt: new Date("2026-01-03T00:00:00.000Z"),
				},
				{
					userId: "member-1",
					conversationId: "conv-archived",
					scope: "general",
					title: "Archived",
					createdAt: new Date("2026-01-04T00:00:00.000Z"),
					lastActivityAt: new Date("2026-01-04T00:00:00.000Z"),
					archivedAt: new Date("2026-01-05T00:00:00.000Z"),
				},
			]);
			const app = buildApp(
				new PostgresConversationStore(tdb.db),
				gateThatFailsIfConsulted(),
			);

			const first = await app.request("/v1/conversations?limit=2", {
				headers: identityHeaders,
			});
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as {
				conversations: Array<{
					conversationId: string;
					title: string | null;
					scope: string;
					createdAt: string;
					lastActivityAt: string;
					archivedAt: string | null;
				}>;
				nextCursor: string | null;
			};
			expect(
				firstBody.conversations.map((item) => item.conversationId),
			).toEqual(["conv-c", "conv-b"]);
			expect(typeof firstBody.nextCursor).toBe("string");
			expect(firstBody.nextCursor).not.toContain("conv-b");
			expect(firstBody.conversations[0]).toEqual({
				conversationId: "conv-c",
				title: "Recent regular C",
				scope: "collection",
				createdAt: "2026-01-03T00:00:00.000Z",
				lastActivityAt: "2026-01-03T00:00:00.000Z",
				archivedAt: null,
			});
			await tdb.db.insert(conversations).values({
				userId: "member-1",
				conversationId: "conv-newer-after-page-one",
				scope: "general",
				title: "Newly active",
				lastActivityAt: new Date("2026-01-06T00:00:00.000Z"),
			});

			const second = await app.request(
				`/v1/conversations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
				{ headers: identityHeaders },
			);
			expect(second.status).toBe(200);
			expect(await second.json()).toMatchObject({
				conversations: [{ conversationId: "conv-a" }],
				nextCursor: null,
			});
			const wrongPartition = await app.request(
				`/v1/conversations?archived=true&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
				{ headers: identityHeaders },
			);
			expect(wrongPartition.status).toBe(400);
		} finally {
			await tdb.close();
		}
	});

	it("searches titles inside the owned Archive partition on the server", async () => {
		const tdb = await createTestDatabase();
		try {
			await tdb.db.insert(conversations).values([
				{
					userId: "member-1",
					conversationId: "owned-archived-match",
					scope: "general",
					title: "Quarterly Planning",
					archivedAt: new Date("2026-01-05T00:00:00.000Z"),
				},
				{
					userId: "member-1",
					conversationId: "owned-regular-match",
					scope: "general",
					title: "Quarterly planning notes",
				},
				{
					userId: "member-1",
					conversationId: "owned-archived-miss",
					scope: "general",
					title: "Travel ideas",
					archivedAt: new Date("2026-01-05T00:00:00.000Z"),
				},
				{
					userId: "other-member",
					conversationId: "foreign-archived-match",
					scope: "general",
					title: "Secret planning",
					archivedAt: new Date("2026-01-05T00:00:00.000Z"),
				},
			]);
			const app = buildApp(
				new PostgresConversationStore(tdb.db),
				gateThatFailsIfConsulted(),
			);

			const res = await app.request(
				"/v1/conversations?archived=true&search=PLANNING",
				{ headers: identityHeaders },
			);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				conversations: [{ conversationId: "owned-archived-match" }],
				nextCursor: null,
			});
		} finally {
			await tdb.close();
		}
	});

	it("preserves Postgres microseconds across activity cursors", async () => {
		const tdb = await createTestDatabase();
		try {
			await tdb.db.execute(sql`
				insert into conversations
					(user_id, conversation_id, scope, title, last_activity_at)
				values
					('member-1', 'micro-newest', 'general', 'Newest', '2026-01-03T00:00:00.000900Z'),
					('member-1', 'micro-next', 'general', 'Next', '2026-01-03T00:00:00.000800Z')
			`);
			const app = buildApp(new PostgresConversationStore(tdb.db));

			const first = await app.request("/v1/conversations?limit=1", {
				headers: identityHeaders,
			});
			const firstBody = (await first.json()) as {
				conversations: Array<{ conversationId: string }>;
				nextCursor: string;
			};
			expect(firstBody.conversations[0]?.conversationId).toBe("micro-newest");

			const second = await app.request(
				`/v1/conversations?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
				{ headers: identityHeaders },
			);
			expect(second.status).toBe(200);
			expect(await second.json()).toMatchObject({
				conversations: [{ conversationId: "micro-next" }],
			});
		} finally {
			await tdb.close();
		}
	});

	it("rejects invalid list parameters and cursors", async () => {
		const tdb = await createTestDatabase();
		try {
			const app = buildApp(new PostgresConversationStore(tdb.db));
			for (const query of [
				"archived=yes",
				"limit=0",
				"limit=101",
				"search=%20%20",
				"cursor=not-a-cursor",
				"unknown=value",
			]) {
				const res = await app.request(`/v1/conversations?${query}`, {
					headers: identityHeaders,
				});
				expect(res.status, query).toBe(400);
			}
		} finally {
			await tdb.close();
		}
	});
});

describe("PATCH /v1/conversations/:id", () => {
	it("renames during an active Run and guards Archive transitions atomically", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			await store.create({
				userId: "member-1",
				conversationId: "conv-lifecycle",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			await tdb.db.insert(runs).values({
				runId: "active-run",
				userId: "member-1",
				conversationId: "conv-lifecycle",
				status: "queued",
			});
			const app = buildApp(store, gateThatFailsIfConsulted());
			const activityBeforeRename = (
				await store.get({
					userId: "member-1",
					conversationId: "conv-lifecycle",
				})
			)?.lastActivityAt.toISOString();

			const renamed = await app.request("/v1/conversations/conv-lifecycle", {
				method: "PATCH",
				headers: identityHeaders,
				body: JSON.stringify({ title: "Quarterly plan" }),
			});
			expect(renamed.status).toBe(200);
			expect(await renamed.json()).toMatchObject({
				conversationId: "conv-lifecycle",
				title: "Quarterly plan",
				lastActivityAt: activityBeforeRename,
				archivedAt: null,
			});

			const blocked = await app.request("/v1/conversations/conv-lifecycle", {
				method: "PATCH",
				headers: identityHeaders,
				body: JSON.stringify({ title: "Must not apply", archived: true }),
			});
			expect(blocked.status).toBe(409);
			expect(
				(
					await store.get({
						userId: "member-1",
						conversationId: "conv-lifecycle",
					})
				)?.title,
			).toBe("Quarterly plan");

			await tdb.db
				.update(runs)
				.set({ status: "done", terminalAt: new Date() })
				.where(eq(runs.runId, "active-run"));
			const archived = await app.request("/v1/conversations/conv-lifecycle", {
				method: "PATCH",
				headers: identityHeaders,
				body: JSON.stringify({ title: "Archived plan", archived: true }),
			});
			expect(archived.status).toBe(200);
			const archivedBody = (await archived.json()) as {
				title: string;
				archivedAt: string | null;
			};
			expect(archivedBody.title).toBe("Archived plan");
			expect(archivedBody.archivedAt).not.toBeNull();

			const unarchived = await app.request("/v1/conversations/conv-lifecycle", {
				method: "PATCH",
				headers: identityHeaders,
				body: JSON.stringify({ archived: false }),
			});
			expect(unarchived.status).toBe(200);
			expect(await unarchived.json()).toMatchObject({ archivedAt: null });
		} finally {
			await tdb.close();
		}
	});

	it("serializes Archive and unarchive racing Run admission", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			await store.create({
				userId: "member-1",
				conversationId: "conv-archive-race",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			await store.create({
				userId: "member-1",
				conversationId: "conv-unarchive-race",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			await store.update(
				{ userId: "member-1", conversationId: "conv-unarchive-race" },
				{ archived: true },
			);
			const durableRuns = new PostgresRunStore(tdb.db);
			const app = buildAppWithDurableRunStore(store, durableRuns);
			const admit = (conversationId: string, runId: string) =>
				app.request(`/v1/conversations/${conversationId}/runs`, {
					method: "POST",
					headers: identityHeaders,
					body: JSON.stringify({
						...agUiRunInput(),
						threadId: conversationId,
						runId,
					}),
				});

			const [archive, archiveAdmission] = await Promise.all([
				app.request("/v1/conversations/conv-archive-race", {
					method: "PATCH",
					headers: identityHeaders,
					body: JSON.stringify({ archived: true }),
				}),
				admit("conv-archive-race", "archive-racing-run"),
			]);
			// The stubbed retained Stream is empty, so a committed admission returns
			// the route's retryable transport response after winning the DB race.
			expect(
				(archive.status === 200 && archiveAdmission.status === 409) ||
					(archive.status === 409 && archiveAdmission.status === 503),
			).toBe(true);
			const archived = await store.get({
				userId: "member-1",
				conversationId: "conv-archive-race",
			});
			const archiveRun = await durableRuns.getRun({
				userId: "member-1",
				conversationId: "conv-archive-race",
				runId: "archive-racing-run",
			});
			if (archive.status === 200) {
				expect(archived?.archivedAt).not.toBeNull();
				expect(archiveRun).toBeNull();
			} else {
				expect(archived?.archivedAt).toBeNull();
				expect(archiveRun).not.toBeNull();
			}

			const [unarchive, unarchiveAdmission] = await Promise.all([
				app.request("/v1/conversations/conv-unarchive-race", {
					method: "PATCH",
					headers: identityHeaders,
					body: JSON.stringify({ archived: false }),
				}),
				admit("conv-unarchive-race", "unarchive-racing-run"),
			]);
			expect(unarchive.status).toBe(200);
			expect([409, 503]).toContain(unarchiveAdmission.status);
			expect(
				(
					await store.get({
						userId: "member-1",
						conversationId: "conv-unarchive-race",
					})
				)?.archivedAt,
			).toBeNull();
			const unarchiveRun = await durableRuns.getRun({
				userId: "member-1",
				conversationId: "conv-unarchive-race",
				runId: "unarchive-racing-run",
			});
			if (unarchiveAdmission.status === 503) {
				expect(unarchiveRun).not.toBeNull();
			} else {
				expect(unarchiveRun).toBeNull();
			}
		} finally {
			await tdb.close();
		}
	});

	it("validates mutations and keeps missing and foreign Conversations private", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			await store.create({
				userId: "other-member",
				conversationId: "foreign-conversation",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			const app = buildApp(store, gateThatFailsIfConsulted());

			for (const body of [
				{},
				{ title: "   " },
				{ archived: "true" },
				{ title: "Valid", extra: true },
			]) {
				const invalid = await app.request(
					"/v1/conversations/foreign-conversation",
					{
						method: "PATCH",
						headers: identityHeaders,
						body: JSON.stringify(body),
					},
				);
				expect(invalid.status).toBe(400);
			}

			const foreign = await app.request(
				"/v1/conversations/foreign-conversation",
				{
					method: "PATCH",
					headers: identityHeaders,
					body: JSON.stringify({ title: "Probe" }),
				},
			);
			const missing = await app.request("/v1/conversations/missing", {
				method: "PATCH",
				headers: identityHeaders,
				body: JSON.stringify({ title: "Probe" }),
			});
			expect(foreign.status).toBe(404);
			expect(missing.status).toBe(404);
			const foreignDelete = await app.request(
				"/v1/conversations/foreign-conversation",
				{ method: "DELETE", headers: identityHeaders },
			);
			const missingDelete = await app.request("/v1/conversations/missing", {
				method: "DELETE",
				headers: identityHeaders,
			});
			expect(foreignDelete.status).toBe(404);
			expect(missingDelete.status).toBe(404);
			expect(
				(
					await store.get({
						userId: "other-member",
						conversationId: "foreign-conversation",
					})
				)?.title,
			).toBeNull();
		} finally {
			await tdb.close();
		}
	});
});

describe("DELETE /v1/conversations/:id", () => {
	it("rejects an active Run, then permanently removes every user-visible resource", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			await store.create({
				userId: "member-1",
				conversationId: "conv-delete",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			await tdb.db.insert(runs).values({
				runId: "delete-run",
				userId: "member-1",
				conversationId: "conv-delete",
				status: "queued",
			});
			const app = buildApp(store, gateThatFailsIfConsulted());

			const blocked = await app.request("/v1/conversations/conv-delete", {
				method: "DELETE",
				headers: identityHeaders,
			});
			expect(blocked.status).toBe(409);

			await tdb.db
				.update(runs)
				.set({ status: "done", terminalAt: new Date() })
				.where(eq(runs.runId, "delete-run"));
			const deleted = await app.request("/v1/conversations/conv-delete", {
				method: "DELETE",
				headers: identityHeaders,
			});
			expect(deleted.status).toBe(204);
			expect(await deleted.text()).toBe("");
			expect(await tdb.db.select().from(runs)).toHaveLength(0);

			const list = await app.request("/v1/conversations", {
				headers: identityHeaders,
			});
			expect(await list.json()).toMatchObject({ conversations: [] });

			const missingRun = await app.request(
				"/v1/conversations/conv-delete/runs",
				{
					method: "POST",
					headers: identityHeaders,
					body: JSON.stringify({
						...agUiRunInput(),
						threadId: "conv-delete",
					}),
				},
			);
			expect(missingRun.status).toBe(404);
			const missingReconnect = await app.request(
				"/v1/conversations/conv-delete/runs/delete-run/events",
				{ headers: identityHeaders },
			);
			expect(missingReconnect.status).toBe(404);
			const missingArtifacts = await app.request(
				"/v1/conversations/conv-delete/artifacts",
				{ headers: identityHeaders },
			);
			expect(missingArtifacts.status).toBe(404);
		} finally {
			await tdb.close();
		}
	});

	it("serializes Permanent deletion racing Run admission", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			await store.create({
				userId: "member-1",
				conversationId: "conv-delete-race",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			const durableRuns = new PostgresRunStore(tdb.db);
			const app = buildAppWithDurableRunStore(store, durableRuns);

			const [deletion, admission] = await Promise.all([
				app.request("/v1/conversations/conv-delete-race", {
					method: "DELETE",
					headers: identityHeaders,
				}),
				app.request("/v1/conversations/conv-delete-race/runs", {
					method: "POST",
					headers: identityHeaders,
					body: JSON.stringify({
						...agUiRunInput(),
						threadId: "conv-delete-race",
						runId: "racing-run",
					}),
				}),
			]);

			expect(
				(deletion.status === 204 && admission.status === 404) ||
					(deletion.status === 409 && admission.status === 204),
			).toBe(true);
			const persisted = await store.get({
				userId: "member-1",
				conversationId: "conv-delete-race",
			});
			const persistedRuns = await tdb.db.select().from(runs);
			if (deletion.status === 204) {
				expect(persisted).toBeNull();
				expect(persistedRuns).toHaveLength(0);
			} else {
				expect(persisted).not.toBeNull();
				expect(persistedRuns).toHaveLength(1);
			}
		} finally {
			await tdb.close();
		}
	});
});

describe("POST /v1/conversations/:id/runs", () => {
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

	it("admits the final plain-text User message and streams standard AG-UI events", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const admissions: unknown[] = [];
		fakeRuns.runStore.admitRun = async (input) => {
			admissions.push(input);
			fakeRuns.runOwners.set(input.runId, {
				userId: input.conversation.userId,
				conversationId: input.conversation.conversationId,
				status: "done",
			});
			return {
				outcome: "created",
				run: runRecord({
					runId: input.runId,
					userId: input.conversation.userId,
					conversationId: input.conversation.conversationId,
					status: "queued",
				}),
			};
		};
		const events = [
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "client-run-1" },
			{
				type: "TEXT_MESSAGE_START",
				messageId: "assistant-1",
				role: "assistant",
			},
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "assistant-1",
				delta: "hello",
			},
			{ type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "client-run-1" },
		];

		const app = buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
			disabledLiveTextSubscriber,
			retainedAgUiStream(events),
		);
		const res = await app.request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(agUiRunInput()),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(admissions).toEqual([
			{
				conversation: existing,
				runId: "client-run-1",
				messageId: "user-message-1",
				message: "hello",
			},
		]);
		const expectedFrames = events.map((data, index) => ({
			id: `${index + 1}-0`,
			data,
		}));
		expect(parseAgUiSse(await res.text())).toEqual(expectedFrames);

		const replay = await app.request(
			"/v1/conversations/conv-1/runs/client-run-1/events",
			{ headers: identityHeaders },
		);
		expect(replay.status).toBe(200);
		expect(parseAgUiSse(await replay.text())).toEqual(expectedFrames);
	});

	it("reattaches an exact retry without consulting the new-work exposure gate", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("client-run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "done",
		});
		fakeRuns.runStore.admitRun = async (input) => ({
			outcome: "existing",
			run: runRecord({
				runId: input.runId,
				userId: input.conversation.userId,
				conversationId: input.conversation.conversationId,
				status: "done",
			}),
		});
		const events = [
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "client-run-1" },
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "client-run-1" },
		];

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			retainedAgUiStream(events),
		).request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(agUiRunInput()),
		});

		expect(res.status).toBe(200);
		expect(parseAgUiSse(await res.text())).toEqual(
			events.map((data, index) => ({ id: `${index + 1}-0`, data })),
		);
	});

	it.each([
		["unknown input fields", agUiRunInput({ model: "client-choice" })],
		["a path/body thread mismatch", agUiRunInput({ threadId: "other" })],
		["client Tools", agUiRunInput({ tools: [{ name: "unsafe" }] })],
		["client state", agUiRunInput({ state: { unsafe: true } })],
		[
			"extra final-message fields",
			agUiRunInput({
				messages: [
					{ id: "u", role: "user", content: "hello", authority: "client" },
				],
			}),
		],
		[
			"a non-User final message",
			agUiRunInput({
				messages: [{ id: "a", role: "assistant", content: "no" }],
			}),
		],
		[
			"multimodal final content",
			agUiRunInput({
				messages: [
					{ id: "u", role: "user", content: [{ type: "text", text: "no" }] },
				],
			}),
		],
	])("rejects %s before admission", async (_name, body) => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		let admitted = false;
		fakeRuns.runStore.admitRun = async () => {
			admitted = true;
			throw new Error("must not admit");
		};

		const res = await buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
		).request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(body),
		});

		expect(res.status).toBe(400);
		expect(admitted).toBe(false);
	});

	it("returns retryable transport failure without rolling back admission", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		let admitted = false;
		fakeRuns.runStore.admitRun = async (input) => {
			admitted = true;
			fakeRuns.runOwners.set(input.runId, {
				userId: input.conversation.userId,
				conversationId: input.conversation.conversationId,
				status: "queued",
			});
			return {
				outcome: "created",
				run: runRecord({
					runId: input.runId,
					userId: input.conversation.userId,
					conversationId: input.conversation.conversationId,
					status: "queued",
				}),
			};
		};
		const res = await buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					return "streaming" as const;
				},
				read() {
					return {
						[Symbol.asyncIterator]() {
							return {
								async next() {
									throw new Error("Redis unavailable");
								},
							};
						},
					};
				},
			},
		).request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(agUiRunInput()),
		});

		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
		expect(admitted).toBe(true);
	});

	it("closes an incomplete stream without synthesizing an AG-UI error", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runStore.admitRun = async (input) => ({
			outcome: "created",
			run: runRecord({
				runId: input.runId,
				userId: input.conversation.userId,
				conversationId: input.conversation.conversationId,
				status: "queued",
			}),
		});
		const encoder = new TextEncoder();
		const res = await buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					return "streaming" as const;
				},
				async *read() {
					yield {
						cursor: "1-0",
						chunk: encoder.encode(
							JSON.stringify({
								type: "RUN_STARTED",
								threadId: "conv-1",
								runId: "client-run-1",
							}),
						),
					};
					throw new Error("Redis failed after streaming began");
				},
			},
		).request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(agUiRunInput()),
		});

		expect(res.status).toBe(200);
		expect(parseAgUiSse(await res.text())).toEqual([
			{
				id: "1-0",
				data: {
					type: "RUN_STARTED",
					threadId: "conv-1",
					runId: "client-run-1",
				},
			},
		]);
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
			admitRun: (input) => durableRunStore.admitRun(input),
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
			async admitRun() {
				throw new Error("AG-UI admission is not used by this test");
			},
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
			async admitRun() {
				throw new Error("AG-UI admission is not used by this test");
			},
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
			async admitRun() {
				throw new Error("AG-UI admission is not used by this test");
			},
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
			async admitRun() {
				throw new Error("AG-UI admission is not used by this test");
			},
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

describe("POST /v1/conversations/:id/runs/:runId/cancel", () => {
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

	it("cancels an owned queued Run without consulting the exposure gate", async () => {
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
		).request("/v1/conversations/conv-1/runs/run-1/cancel", {
			method: "POST",
			headers: identityHeaders,
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ runId: "run-1", status: "canceled" });
		expect(fakeRuns.cancellations).toEqual([
			{ userId: "member-1", conversationId: "conv-1", runId: "run-1" },
		]);
	});

	it("moves a running Run to cancel_requested", async () => {
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
		).request("/v1/conversations/conv-1/runs/run-1/cancel", {
			method: "POST",
			headers: identityHeaders,
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({
			runId: "run-1",
			status: "cancel_requested",
		});
	});

	it("returns 409 for a terminal Run and 404 for missing ownership", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		for (const status of ["done", "error", "canceled"]) {
			fakeRuns.runOwners.set(`${status}-run`, {
				userId: "member-1",
				conversationId: "conv-1",
				status,
			});
		}
		fakeRuns.runOwners.set("foreign-run", {
			userId: "other-member",
			conversationId: "conv-1",
			status: "running",
		});
		const app = buildApp(store, gateThatFailsIfConsulted(), fakeRuns);

		for (const status of ["done", "error", "canceled"]) {
			const terminal = await app.request(
				`/v1/conversations/conv-1/runs/${status}-run/cancel`,
				{ method: "POST", headers: identityHeaders },
			);
			expect(terminal.status).toBe(409);
			expect(await terminal.json()).toEqual({
				runId: `${status}-run`,
				status,
			});
		}

		for (const runId of ["missing-run", "foreign-run"]) {
			const response = await app.request(
				`/v1/conversations/conv-1/runs/${runId}/cancel`,
				{ method: "POST", headers: identityHeaders },
			);
			expect(response.status).toBe(404);
		}
	});

	it("validates identity and path parameters", async () => {
		const { store } = fakeStore([existing]);
		const app = buildApp(store);

		const unauthorized = await app.request(
			"/v1/conversations/conv-1/runs/run-1/cancel",
			{ method: "POST" },
		);
		expect(unauthorized.status).toBe(401);

		const unsafe = await app.request(
			"/v1/conversations/conv-1/runs/%2E%2E%2Fescape/cancel",
			{ method: "POST", headers: identityHeaders },
		);
		expect(unsafe.status).toBe(400);
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

	it("returns 400 for a malformed Last-Event-ID before reading the Live Stream", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
		});
		let redisRead = false;
		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					redisRead = true;
					return "streaming" as const;
				},
				read() {
					redisRead = true;
					throw new Error("Live Stream must not be read");
				},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "not-a-cursor" },
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid Last-Event-ID" });
		expect(redisRead).toBe(false);
	});

	it("returns 400 for a Redis-shaped Last-Event-ID the Stream never issued", async () => {
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
			disabledLiveTextSubscriber,
			{
				async status() {
					return "done" as const;
				},
				read() {
					return {
						[Symbol.asyncIterator]() {
							return {
								async next() {
									throw new LiveStreamStoreError("invalid_cursor");
								},
							};
						},
					};
				},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "9999999999999-0" },
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid Last-Event-ID" });
	});

	it("returns recovery 410 for a Run whose Live Stream failed without reading Redis", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
			liveStreamFailedAt: new Date("2026-01-01T00:01:00.000Z"),
		});
		let redisRead = false;
		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					redisRead = true;
					return "error" as const;
				},
				read() {
					redisRead = true;
					throw new Error("Live Stream must not be read");
				},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
		expect(redisRead).toBe(false);
	});

	it("returns retryable 503 for a temporary read failure while the Run is active", async () => {
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
			disabledLiveTextSubscriber,
			{
				async status() {
					throw new Error("temporary Redis failure");
				},
				async *read() {},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error: "Live stream temporarily unavailable",
		});
	});

	it("returns recovery 410 when the failure marker races the first Live Stream read", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const owner = {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
			liveStreamFailedAt: null as Date | null,
		};
		fakeRuns.runOwners.set("run-1", owner);
		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					return "streaming" as const;
				},
				read() {
					return {
						[Symbol.asyncIterator]() {
							return {
								async next() {
									owner.liveStreamFailedAt = new Date();
									throw new Error("Redis failed permanently");
								},
							};
						},
					};
				},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
	});

	it("closes a failed open Live Stream, then returns the Recovering signal", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const owner = {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
			liveStreamFailedAt: null as Date | null,
		};
		fakeRuns.runOwners.set("run-1", owner);
		const encoder = new TextEncoder();
		let statusReads = 0;
		const app = buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					statusReads++;
					return "streaming" as const;
				},
				async *read() {
					yield {
						cursor: "1-0",
						chunk: encoder.encode(
							JSON.stringify({
								type: "RUN_STARTED",
								threadId: "conv-1",
								runId: "run-1",
							}),
						),
					};
					owner.liveStreamFailedAt = new Date();
					throw new Error("Redis failed mid-stream");
				},
			},
		);

		const first = await app.request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ method: "GET", headers: identityHeaders },
		);
		expect(first.status).toBe(200);
		expect(parseAgUiSse(await first.text())).toEqual([
			{
				id: "1-0",
				data: {
					type: "RUN_STARTED",
					threadId: "conv-1",
					runId: "run-1",
				},
			},
		]);

		const recoveryResponse = await app.request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{
				method: "GET",
				headers: { ...identityHeaders, "last-event-id": "1-0" },
			},
		);
		expect(recoveryResponse.status).toBe(410);
		expect(await recoveryResponse.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
		expect(statusReads).toBe(1);
	});

	it("returns recovery 410 when a terminal Run's retained Live Stream is missing", async () => {
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
			disabledLiveTextSubscriber,
			{
				async status() {
					return "missing" as const;
				},
				async *read() {},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
	}, 7_000);

	it("returns recovery 410 when a terminal Live Stream has no terminal event to replay", async () => {
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
			disabledLiveTextSubscriber,
			{
				async status() {
					return "done" as const;
				},
				async *read() {},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
	});

	it("returns 400 when an active Run has no Live Stream that could have issued the cursor", async () => {
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
			disabledLiveTextSubscriber,
			{
				async status() {
					return "missing" as const;
				},
				async *read() {},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "1-0" },
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid Last-Event-ID" });
	}, 7_000);

	it("waits past startup delay with cursorless pings, then streams the terminal event", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "queued",
		});
		const encoder = new TextEncoder();
		const readyAt = Date.now() + 5_100;
		const terminalEvent = {
			type: "RUN_FINISHED",
			threadId: "conv-1",
			runId: "run-1",
		};
		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					return Date.now() >= readyAt
						? ("done" as const)
						: ("missing" as const);
				},
				async *read() {
					yield {
						cursor: "1-0",
						chunk: encoder.encode(JSON.stringify(terminalEvent)),
					};
				},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain(": ping\n\n");
		expect(parseAgUiSse(body)).toEqual([{ id: "1-0", data: terminalEvent }]);
	}, 8_000);

	it("follows a Live Stream that appears just after Postgres terminalizes the Run", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const owner = {
			userId: "member-1",
			conversationId: "conv-1",
			status: "queued",
		};
		fakeRuns.runOwners.set("run-1", owner);
		const encoder = new TextEncoder();
		const terminalEvent = {
			type: "RUN_FINISHED",
			threadId: "conv-1",
			runId: "run-1",
		};
		let statusReads = 0;
		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					statusReads += 1;
					if (statusReads === 1) {
						owner.status = "done";
						return "missing" as const;
					}
					return "streaming" as const;
				},
				async *read() {
					yield {
						cursor: "1-0",
						chunk: encoder.encode(JSON.stringify(terminalEvent)),
					};
				},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: identityHeaders,
		});

		expect(res.status).toBe(200);
		expect(parseAgUiSse(await res.text())).toEqual([
			{ id: "1-0", data: terminalEvent },
		]);
	});

	it("sends cursorless pings while following a quiet active Stream", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
		});
		const encoder = new TextEncoder();
		const terminalEvent = {
			type: "RUN_FINISHED",
			threadId: "conv-1",
			runId: "run-1",
		};
		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			{
				async status() {
					return "streaming" as const;
				},
				async *read() {
					await Bun.sleep(5_100);
					yield {
						cursor: "2-0",
						chunk: encoder.encode(JSON.stringify(terminalEvent)),
					};
				},
			},
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "1-0" },
		});

		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain(": ping\n\n");
		expect(parseAgUiSse(body)).toEqual([{ id: "2-0", data: terminalEvent }]);
	}, 8_000);

	it("replays strictly after a retained Live Stream cursor without creating work", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const { queued, runOwners } = fakeRuns;
		runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "done",
		});
		const events = [
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
			{ type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "hi" },
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "run-1" },
		];

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			disabledLiveTextSubscriber,
			retainedAgUiStream(events),
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			method: "GET",
			headers: { ...identityHeaders, "last-event-id": "1-0" },
		});

		expect(res.status).toBe(200);
		expect(parseAgUiSse(await res.text())).toEqual([
			{ id: "2-0", data: events[1] },
			{ id: "3-0", data: events[2] },
		]);
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
