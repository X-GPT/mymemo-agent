import { describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import { startCanaryCampaignTx } from "@mymemo/agent-db/canary-control";
import { markFargateLaneAwareDeploymentReady } from "@mymemo/agent-db/execution-lane-deployment";
import {
	createInMemoryLiveStreamRelay,
	createLiveStreamTelemetry,
	encodeAgUiLiveStreamEvent,
	type LiveStreamEvent,
	type LiveStreamProducer,
	type LiveStreamRelay,
	type LiveStreamTelemetry,
} from "@mymemo/live-text";
import { eq, sql } from "drizzle-orm";
import type { ApiConfig } from "@/config/env";
import {
	canaryCampaigns,
	canaryDispatchOutbox,
	conversations,
	runs,
} from "@/db/schema";
import { createTestDatabase } from "@/db/testing";
import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationStore,
} from "@/features/conversation-store";
import { PostgresConversationStore } from "@/features/conversation-store";
import type { ExposureGate } from "@/features/exposure-gate";
import {
	PostgresRunStore,
	type RunRecord,
	type RunStore,
} from "@/features/run-store";
import type { InternalIdentity } from "./conversations.schema";

const { createApp } = await import("@/app");
const silentLiveStreamTelemetry = createLiveStreamTelemetry("chat-api", {
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
	liveStreamRelay: LiveStreamRelay = createInMemoryLiveStreamRelay(),
	liveStreamTelemetry: LiveStreamTelemetry = silentLiveStreamTelemetry,
) {
	const deps = {
		config: {},
		conversationStore,
		exposureGate,
		runStore: fakeRuns.runStore,
		liveStreamRelay,
		liveStreamTelemetry,
	} as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as unknown as ApiConfig, deps);
}

function buildAppWithDurableRunStore(
	conversationStore: ConversationStore,
	runStore: RunStore,
) {
	const relay = createInMemoryLiveStreamRelay();
	void relay.close();
	return buildApp(
		conversationStore,
		recordingGate(true).gate,
		{ ...fakeRunStore(), runStore },
		relay,
	);
}

function fakeRunStore() {
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
	const interruptions: Array<{
		userId: string;
		conversationId: string;
		runId: string;
	}> = [];
	const runStore: RunStore = {
		async admitRun() {
			throw new Error("AG-UI admission is not used by this test");
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
			return runRecord({
				runId,
				...owner,
			});
		},
		async requestInterruption({ userId, conversationId, runId }) {
			interruptions.push({ userId, conversationId, runId });
			const owner = runOwners.get(runId);
			if (
				!owner ||
				owner.userId !== userId ||
				owner.conversationId !== conversationId
			) {
				return { outcome: "not_found" };
			}
			if (owner.status === "queued") {
				owner.status = "interrupted";
				return { outcome: "interrupted", run: runRecord({ runId, ...owner }) };
			}
			if (
				owner.status === "running" ||
				owner.status === "interrupt_requested"
			) {
				owner.status = "interrupt_requested";
				return {
					outcome: "interrupt_requested",
					run: runRecord({ runId, ...owner }),
				};
			}
			if (owner.status === "interrupted") {
				// Mirrors the real store: a retry after the interruption won stays
				// a success, distinct from the done/error conflict (ADR-0013).
				return { outcome: "interrupted", run: runRecord({ runId, ...owner }) };
			}
			return {
				outcome: "already_terminal",
				run: runRecord({ runId, ...owner }),
			};
		},
	};
	return {
		runStore,
		runOwners,
		interruptions,
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
		executedByWorkerId: null,
		interruptRequestedAt: null,
		liveStreamFailedAt: input.liveStreamFailedAt ?? null,
		nextEventSeq: input.nextEventSeq ?? 1,
		terminalAt: null,
	};
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

async function relayWithEvents(
	runId: string,
	events: unknown[],
): Promise<{ relay: LiveStreamRelay; producer: LiveStreamProducer }> {
	const relay = createInMemoryLiveStreamRelay();
	const producer = await relay.openProducer(runId);
	for (const [index, event] of events.entries()) {
		const [chunk] = encodeAgUiLiveStreamEvent(event as never);
		if (!chunk) throw new Error("test event encoded empty");
		if (index === events.length - 1) await producer.publishTerminal(chunk);
		else await producer.append(chunk);
	}
	return { relay, producer };
}

function parseAgUiSse(text: string): unknown[] {
	return text
		.trim()
		.split("\n\n")
		.filter((block) => block.includes("data:"))
		.map((block) => {
			const lines = block.split("\n");
			if (lines.some((line) => line.startsWith("id:"))) {
				throw new Error(`AG-UI SSE block must not carry an id: ${block}`);
			}
			const data = lines
				.find((line) => line.startsWith("data:"))
				?.slice(5)
				.trim();
			if (!data) throw new Error(`malformed AG-UI SSE block: ${block}`);
			return JSON.parse(data);
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

	it("does not let public callers select an execution lane", async () => {
		const { store, created } = fakeStore();
		const res = await buildApp(store).request("/v1/conversations", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify({ executionLane: "agentcore_canary" }),
		});

		expect(res.status).toBe(400);
		expect(created).toHaveLength(0);
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
			// The closed relay returns a retryable transport response after the
			// committed admission wins the DB race.
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
	it("deletes an AgentCore-canary Conversation through HTTP without deleting its audit", async () => {
		const tdb = await createTestDatabase();
		try {
			await markFargateLaneAwareDeploymentReady(tdb.db);
			await startCanaryCampaignTx(tdb.db, {
				campaignId: "campaign-delete",
				idempotencyKey: "key-delete",
				campaignVersion: "v1",
				fixtureVersion: "fixture-v1",
				fixtureChecksum: "fixture-checksum",
				model: "model",
				scenarioId: "scenario",
				userId: "member-1",
				conversationId: "canary-delete",
				collectionId: "canary-collection",
				runId: "canary-delete-run",
				messageId: "canary-delete-message",
				dispatchId: "canary-delete-dispatch",
				prompt: "configured synthetic prompt",
			});
			await tdb.db
				.update(runs)
				.set({ status: "done", terminalAt: new Date() })
				.where(eq(runs.runId, "canary-delete-run"));
			const app = buildApp(
				new PostgresConversationStore(tdb.db),
				gateThatFailsIfConsulted(),
			);

			const deleted = await app.request("/v1/conversations/canary-delete", {
				method: "DELETE",
				headers: identityHeaders,
			});

			expect(deleted.status).toBe(204);
			expect(await tdb.db.select().from(runs)).toEqual([]);
			expect(await tdb.db.select().from(canaryCampaigns)).toMatchObject([
				{
					campaignId: "campaign-delete",
					conversationId: "canary-delete",
					runId: "canary-delete-run",
				},
			]);
			expect(await tdb.db.select().from(canaryDispatchOutbox)).toMatchObject([
				{
					dispatchId: "canary-delete-dispatch",
					conversationId: "canary-delete",
					runId: "canary-delete-run",
				},
			]);
		} finally {
			await tdb.close();
		}
	});

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

	it("streams the relay backlog through the terminal event", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runStore.admitRun = async (input) => {
			fakeRuns.runOwners.set(input.runId, {
				userId: input.conversation.userId,
				conversationId: input.conversation.conversationId,
				status: "running",
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
		const relay = createInMemoryLiveStreamRelay();
		const producer = await relay.openProducer("client-run-1");
		const [started] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_STARTED,
			threadId: "conv-1",
			runId: "client-run-1",
		});
		const [terminal] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_FINISHED,
			threadId: "conv-1",
			runId: "client-run-1",
		});
		if (!started || !terminal) throw new Error("test event encoded empty");
		await producer.append(started);
		await producer.publishTerminal(terminal);

		const response = await buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
			relay,
		).request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(agUiRunInput()),
		});

		expect(response.status).toBe(200);
		expect(parseAgUiSse(await response.text())).toEqual([
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "client-run-1" },
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "client-run-1" },
		]);
		await producer.close();
		await relay.close();
	});

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

		const live = await relayWithEvents("client-run-1", events);
		const app = buildApp(store, recordingGate(true).gate, fakeRuns, live.relay);
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
		expect(parseAgUiSse(await res.text())).toEqual(events);

		const replay = await app.request(
			"/v1/conversations/conv-1/runs/client-run-1/events",
			{ headers: identityHeaders },
		);
		expect(replay.status).toBe(410);
		expect(await replay.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
		await live.producer.close();
		await live.relay.close();
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

		const live = await relayWithEvents("client-run-1", events);
		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			live.relay,
		).request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(agUiRunInput()),
		});

		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
		await live.producer.close();
		await live.relay.close();
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
		const relay = createInMemoryLiveStreamRelay();
		await relay.close();
		const res = await buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
			relay,
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
		const relay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ eventType }) =>
					eventType === EventType.TEXT_MESSAGE_CONTENT,
			},
		});
		const producer = await relay.openProducer("client-run-1");
		const [started] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_STARTED,
			threadId: "conv-1",
			runId: "client-run-1",
		});
		if (!started) throw new Error("test event encoded empty");
		await producer.append(started);
		const responsePromise = buildApp(
			store,
			recordingGate(true).gate,
			fakeRuns,
			relay,
		).request("/v1/conversations/conv-1/runs", {
			method: "POST",
			headers: identityHeaders,
			body: JSON.stringify(agUiRunInput()),
		});
		await Bun.sleep(10);
		const [content] = encodeAgUiLiveStreamEvent({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "assistant-1",
			delta: "not delivered",
		});
		if (!content) throw new Error("test event encoded empty");
		await expect(producer.append(content)).rejects.toThrow();
		const res = await responsePromise;

		expect(res.status).toBe(200);
		expect(parseAgUiSse(await res.text())).toEqual([
			{
				type: "RUN_STARTED",
				threadId: "conv-1",
				runId: "client-run-1",
			},
		]);
		await producer.close();
		await relay.close();
	});
});

it("does not mount the legacy Conversation events admission route", async () => {
	const { store } = fakeStore();
	const res = await buildApp(store).request("/v1/conversations/conv-1/events", {
		method: "POST",
		headers: identityHeaders,
		body: JSON.stringify({}),
	});

	expect(res.status).toBe(404);
});

describe("POST /v1/conversations/:id/runs/:runId/interrupt", () => {
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

	it("interrupts an owned queued Run without consulting the exposure gate", async () => {
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
		).request("/v1/conversations/conv-1/runs/run-1/interrupt", {
			method: "POST",
			headers: identityHeaders,
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ runId: "run-1", status: "interrupted" });
		expect(fakeRuns.interruptions).toEqual([
			{ userId: "member-1", conversationId: "conv-1", runId: "run-1" },
		]);
	});

	it("moves a running Run to interrupt_requested", async () => {
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
		).request("/v1/conversations/conv-1/runs/run-1/interrupt", {
			method: "POST",
			headers: identityHeaders,
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({
			runId: "run-1",
			status: "interrupt_requested",
		});
	});

	it("returns 409 for a done/error Run and 404 for missing ownership", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		for (const status of ["done", "error"]) {
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

		for (const status of ["done", "error"]) {
			const terminal = await app.request(
				`/v1/conversations/conv-1/runs/${status}-run/interrupt`,
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
				`/v1/conversations/conv-1/runs/${runId}/interrupt`,
				{ method: "POST", headers: identityHeaders },
			);
			expect(response.status).toBe(404);
		}
	});

	it("stays 202 when retried after the interruption already won", async () => {
		// ADR-0013 retry contract: a Run whose interruption terminalized is a
		// safe retry — never the 409 reserved for done/error Outcomes.
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "interrupted",
		});

		const res = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
		).request("/v1/conversations/conv-1/runs/run-1/interrupt", {
			method: "POST",
			headers: identityHeaders,
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ runId: "run-1", status: "interrupted" });
	});

	it("no longer serves the removed /cancel endpoint", async () => {
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

		expect(res.status).toBe(404);
		expect(fakeRuns.interruptions).toEqual([]);
	});

	it("validates identity and path parameters", async () => {
		const { store } = fakeStore([existing]);
		const app = buildApp(store);

		const unauthorized = await app.request(
			"/v1/conversations/conv-1/runs/run-1/interrupt",
			{ method: "POST" },
		);
		expect(unauthorized.status).toBe(401);

		const unsafe = await app.request(
			"/v1/conversations/conv-1/runs/%2E%2E%2Fescape/interrupt",
			{ method: "POST", headers: identityHeaders },
		);
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

	it("validates ownership before attaching to the relay", async () => {
		const unauthorized = await buildApp(fakeStore([existing]).store).request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ method: "GET" },
		);
		expect(unauthorized.status).toBe(401);

		const missingConversation = await buildApp(fakeStore().store).request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ method: "GET", headers: identityHeaders },
		);
		expect(missingConversation.status).toBe(404);

		const { store } = fakeStore([existing]);
		const missingRun = await buildApp(store).request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ method: "GET", headers: identityHeaders },
		);
		expect(missingRun.status).toBe(404);
	});

	it("returns recovery 410 for failed and terminal Runs without attaching", async () => {
		const { store } = fakeStore([existing]);
		const metrics: Record<string, unknown>[] = [];
		const telemetry = createLiveStreamTelemetry("chat-api", {
			info: (event) => metrics.push(event),
			warn: (event) => metrics.push(event),
		});
		const relay = createInMemoryLiveStreamRelay({ telemetry });
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("failed-run", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
			liveStreamFailedAt: new Date(),
		});
		fakeRuns.runOwners.set("done-run", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "done",
		});

		for (const runId of ["failed-run", "done-run"]) {
			const response = await buildApp(
				store,
				gateThatFailsIfConsulted(),
				fakeRuns,
				relay,
				telemetry,
			).request(`/v1/conversations/conv-1/runs/${runId}/events`, {
				headers: identityHeaders,
			});
			expect(response.status).toBe(410);
			expect(await response.json()).toEqual({
				error: "Live stream unavailable",
				recovery: "history",
			});
		}
		expect(
			metrics.some((metric) => metric.operation === "attach_attempt"),
		).toBe(false);
		await relay.close();
	});

	it("preserves retryable 503 versus history 410 discrimination", async () => {
		const { store } = fakeStore([existing]);
		const metrics: Record<string, unknown>[] = [];
		const telemetry = createLiveStreamTelemetry("chat-api", {
			info: (event) => metrics.push(event),
			warn: (event) => metrics.push(event),
		});
		const unavailableRelay = createInMemoryLiveStreamRelay({ telemetry });
		await unavailableRelay.close();
		const activeRuns = fakeRunStore();
		activeRuns.runOwners.set("active-run", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
			liveStreamFailedAt: null,
		});
		const reconnect = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			activeRuns,
			unavailableRelay,
			telemetry,
		).request("/v1/conversations/conv-1/runs/active-run/events", {
			headers: identityHeaders,
		});
		expect(reconnect.status).toBe(503);
		expect(await reconnect.json()).toEqual({
			error: "Live stream temporarily unavailable",
		});

		const activeOwner = activeRuns.runOwners.get("active-run");
		if (!activeOwner) throw new Error("active Run fixture missing");
		activeOwner.liveStreamFailedAt = new Date();
		const recovery = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			activeRuns,
			unavailableRelay,
			telemetry,
		).request("/v1/conversations/conv-1/runs/active-run/events", {
			headers: identityHeaders,
		});
		expect(recovery.status).toBe(410);
		expect(metrics).toContainEqual(
			expect.objectContaining({
				operation: "reconnect_response",
				result: "retryable_503",
				reason: "relay_closed",
			}),
		);
		expect(metrics).toContainEqual(
			expect.objectContaining({
				operation: "recovery_response",
				result: "history_410",
			}),
		);
	});

	it("serves history when the Run terminalizes during the backlog wait", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const owner = {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
		};
		fakeRuns.runOwners.set("run-1", owner);
		const relay = createInMemoryLiveStreamRelay({ backlogWaitMs: 20 });
		setTimeout(() => {
			owner.status = "done";
		}, 5);

		const response = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			relay,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			headers: identityHeaders,
		});

		expect(response.status).toBe(410);
		expect(await response.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
		await relay.close();
	});

	it("gives concurrent reconnects the full backlog plus live tail without duplicates", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const owner = {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
		};
		fakeRuns.runOwners.set("run-1", owner);
		const relay = createInMemoryLiveStreamRelay();
		const producer = await relay.openProducer("run-1");
		const backlogEvents: LiveStreamEvent[] = [
			{ type: EventType.RUN_STARTED, threadId: "conv-1", runId: "run-1" },
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: "assistant-1",
				role: "assistant" as const,
			},
		];
		for (const event of backlogEvents) {
			const [chunk] = encodeAgUiLiveStreamEvent(event);
			if (!chunk) throw new Error("test event encoded empty");
			await producer.append(chunk);
		}
		const app = buildApp(store, gateThatFailsIfConsulted(), fakeRuns, relay);
		const firstResponse = app.request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ headers: identityHeaders },
		);
		const reconnectResponse = app.request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ headers: { ...identityHeaders, "last-event-id": "ignored" } },
		);
		await Bun.sleep(20);
		const tailEvents: LiveStreamEvent[] = [
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "assistant-1",
				delta: "hello",
			},
			{
				type: EventType.CUSTOM,
				name: "mymemo.generative_ui",
				value: {
					eventId: "run-1:2",
					messageId: "assistant-1",
					version: 1,
					payload: {
						component: "diagram",
						props: { source: "flowchart LR\nA --> B" },
					},
				},
			},
			{ type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
		];
		for (const event of tailEvents) {
			const [chunk] = encodeAgUiLiveStreamEvent(event);
			if (!chunk) throw new Error("test event encoded empty");
			await producer.append(chunk);
		}
		owner.status = "done";
		const [terminal] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_FINISHED,
			threadId: "conv-1",
			runId: "run-1",
		});
		if (!terminal) throw new Error("test event encoded empty");
		await producer.publishTerminal(terminal);

		const bodies = await Promise.all([
			Promise.resolve(firstResponse).then((response) => response.text()),
			Promise.resolve(reconnectResponse).then((response) => response.text()),
		]);
		const expected = [
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
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
			{
				type: "CUSTOM",
				name: "mymemo.generative_ui",
				value: {
					eventId: "run-1:2",
					messageId: "assistant-1",
					version: 1,
					payload: {
						component: "diagram",
						props: { source: "flowchart LR\nA --> B" },
					},
				},
			},
			{ type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "run-1" },
		];
		expect(bodies.map(parseAgUiSse)).toEqual([expected, expected]);
		await producer.close();
		await relay.close();
	});

	it("aborts the attached relay reader when the SSE client disconnects", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		fakeRuns.runOwners.set("run-1", {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
		});
		const [started] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_STARTED,
			threadId: "conv-1",
			runId: "run-1",
		});
		if (!started) throw new Error("test event encoded empty");
		let attachedSignal: AbortSignal | undefined;
		const relay: LiveStreamRelay = {
			async openProducer() {
				throw new Error("producer is not used by this route test");
			},
			async attach(_runId, signal) {
				attachedSignal = signal;
				return {
					outcome: "attached" as const,
					events: {
						async *[Symbol.asyncIterator]() {
							yield started;
							await new Promise<void>((resolve) => {
								if (signal.aborted) resolve();
								else
									signal.addEventListener("abort", () => resolve(), {
										once: true,
									});
							});
						},
					},
				};
			},
			async close() {},
		};
		const requestAbort = new AbortController();
		const response = await buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			relay,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			headers: identityHeaders,
			signal: requestAbort.signal,
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected streaming response body");

		expect((await reader.read()).done).toBe(false);
		await reader.cancel();
		await Bun.sleep(0);
		expect(attachedSignal?.aborted).toBe(true);
		requestAbort.abort();
	});

	it("keeps a queued Run open with pings while retrying until its producer answers", async () => {
		const { store } = fakeStore([existing]);
		const metrics: Record<string, unknown>[] = [];
		const telemetry = createLiveStreamTelemetry("chat-api", {
			info: (event) => metrics.push(event),
			warn: (event) => metrics.push(event),
		});
		const fakeRuns = fakeRunStore();
		const owner = {
			userId: "member-1",
			conversationId: "conv-1",
			status: "queued",
		};
		fakeRuns.runOwners.set("run-1", owner);
		const relay = createInMemoryLiveStreamRelay({
			backlogWaitMs: 20,
			telemetry,
		});
		const responsePromise = buildApp(
			store,
			gateThatFailsIfConsulted(),
			fakeRuns,
			relay,
			telemetry,
		).request("/v1/conversations/conv-1/runs/run-1/events", {
			headers: identityHeaders,
		});

		await Bun.sleep(5_100);
		owner.status = "running";
		const producer = await relay.openProducer("run-1");
		const [started] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_STARTED,
			threadId: "conv-1",
			runId: "run-1",
		});
		if (!started) throw new Error("test event encoded empty");
		await producer.append(started);
		owner.status = "done";
		const [terminal] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_FINISHED,
			threadId: "conv-1",
			runId: "run-1",
		});
		if (!terminal) throw new Error("test event encoded empty");
		await producer.publishTerminal(terminal);

		const response = await responsePromise;
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain(": ping\n\n");
		expect(parseAgUiSse(body)).toEqual([
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "run-1" },
		]);
		expect(metrics).toContainEqual(
			expect.objectContaining({
				operation: "attach_attempt",
				result: "retry",
			}),
		);
		await producer.close();
		await relay.close();
	}, 8_000);

	it("closes an incomplete relay stream and recovers from history on the next attach", async () => {
		const { store } = fakeStore([existing]);
		const fakeRuns = fakeRunStore();
		const owner = {
			userId: "member-1",
			conversationId: "conv-1",
			status: "running",
			liveStreamFailedAt: null as Date | null,
		};
		fakeRuns.runOwners.set("run-1", owner);
		const relay = createInMemoryLiveStreamRelay({
			testHooks: {
				failEventPublishWhen: ({ eventType }) =>
					eventType === EventType.TEXT_MESSAGE_CONTENT,
			},
		});
		const producer = await relay.openProducer("run-1");
		const [started] = encodeAgUiLiveStreamEvent({
			type: EventType.RUN_STARTED,
			threadId: "conv-1",
			runId: "run-1",
		});
		if (!started) throw new Error("test event encoded empty");
		await producer.append(started);
		const app = buildApp(store, gateThatFailsIfConsulted(), fakeRuns, relay);
		const firstResponse = app.request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ headers: identityHeaders },
		);
		await Bun.sleep(20);
		owner.liveStreamFailedAt = new Date();
		const [content] = encodeAgUiLiveStreamEvent({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "assistant-1",
			delta: "not delivered",
		});
		if (!content) throw new Error("test event encoded empty");
		await expect(producer.append(content)).rejects.toThrow();

		const first = await firstResponse;
		expect(first.status).toBe(200);
		expect(parseAgUiSse(await first.text())).toEqual([
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
		]);
		const recovery = await app.request(
			"/v1/conversations/conv-1/runs/run-1/events",
			{ headers: identityHeaders },
		);
		expect(recovery.status).toBe(410);
		expect(await recovery.json()).toEqual({
			error: "Live stream unavailable",
			recovery: "history",
		});
		await producer.close();
		await relay.close();
	});
});
describe("exposure gate (MYM-46)", () => {
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
