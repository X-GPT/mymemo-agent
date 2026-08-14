import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	agentSessions,
	artifactObjects,
	canaryCampaigns,
	canaryDispatchOutbox,
	conversationArtifacts,
	conversationRuntime,
	conversations,
	orphanSandboxes,
	runs,
} from "@mymemo/agent-db/schema";
import { loadAgentSessionEntriesTx } from "@mymemo/agent-db/session-store";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { and, eq } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import {
	type CleanupPassOptions,
	runCleanupPass,
	type SandboxJanitor,
} from "./cleanup";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

/** Records janitor calls; can be told to fail specific ids to prove retry. */
class FakeJanitor implements SandboxJanitor {
	killed: string[] = [];
	killFailIds = new Set<string>();

	async killSandbox(sandboxId: string): Promise<void> {
		if (this.killFailIds.has(sandboxId)) throw new Error("E2B kill failed");
		this.killed.push(sandboxId);
	}
}

class FakeArtifactJanitor {
	deleted: string[] = [];
	deleteFailKeys = new Set<string>();

	async deleteObject(objectKey: string): Promise<void> {
		if (this.deleteFailKeys.has(objectKey)) {
			throw new Error("S3 delete failed");
		}
		this.deleted.push(objectKey);
	}
}

let tdb: TestDb;
let janitor: FakeJanitor;
let artifactJanitor: FakeArtifactJanitor;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via truncate, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(() => {
	janitor = new FakeJanitor();
	artifactJanitor = new FakeArtifactJanitor();
});

afterEach(async () => {
	await tdb.db.delete(canaryDispatchOutbox);
	await tdb.db.delete(canaryCampaigns);
	await tdb.db.delete(artifactObjects);
	await tdb.db.delete(orphanSandboxes);
	await tdb.db.delete(runs);
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
	await tdb.db.delete(agentSessions);
});

function pass(overrides?: Partial<CleanupPassOptions>) {
	return runCleanupPass({
		db: tdb.db,
		sandboxJanitor: janitor,
		artifactJanitor,
		workerId: "worker-1",
		logger: silentLogger,
		...overrides,
	});
}

describe("Canary audit cleanup", () => {
	it("expires completed Campaign audit at its deadline and retains every ineligible record", async () => {
		const now = new Date("2026-08-14T00:00:00.000Z");
		await tdb.db.insert(canaryCampaigns).values([
			{
				campaignId: "campaign-expired",
				idempotencyKey: "key-expired",
				campaignVersion: "v1",
				fixtureVersion: "fixture-v1",
				fixtureChecksum: "fixture-checksum",
				inputChecksum: "input-checksum-expired",
				model: "model",
				scenarioId: "scenario",
				userId: "canary-user",
				conversationId: "conversation-expired",
				runId: "run-expired",
				messageId: "message-expired",
				lifecycle: "complete",
				verdict: "inconclusive",
				expiresAt: new Date("2026-08-13T23:59:59.000Z"),
			},
			{
				campaignId: "campaign-retained",
				idempotencyKey: "key-retained",
				campaignVersion: "v1",
				fixtureVersion: "fixture-v1",
				fixtureChecksum: "fixture-checksum",
				inputChecksum: "input-checksum-retained",
				model: "model",
				scenarioId: "scenario",
				userId: "canary-user",
				conversationId: "conversation-retained",
				runId: "run-retained",
				messageId: "message-retained",
				lifecycle: "complete",
				verdict: "inconclusive",
				expiresAt: new Date("2026-08-14T00:00:01.000Z"),
			},
		]);
		await tdb.db.insert(canaryDispatchOutbox).values([
			{
				dispatchId: "dispatch-expired",
				campaignId: "campaign-expired",
				scenarioId: "scenario",
				userId: "canary-user",
				conversationId: "conversation-expired",
				runId: "run-expired",
				executionLane: "agentcore_canary",
				expiresAt: new Date("2026-08-13T23:59:59.000Z"),
			},
			{
				dispatchId: "dispatch-retained",
				campaignId: "campaign-retained",
				scenarioId: "scenario",
				userId: "canary-user",
				conversationId: "conversation-retained",
				runId: "run-retained",
				executionLane: "agentcore_canary",
				expiresAt: new Date("2026-08-14T00:00:01.000Z"),
			},
		]);

		const summary = await pass({ now });

		expect(
			(await tdb.db.select().from(canaryCampaigns)).map(
				(row) => row.campaignId,
			),
		).toEqual(["campaign-retained"]);
		expect(
			(await tdb.db.select().from(canaryDispatchOutbox)).map(
				(row) => row.dispatchId,
			),
		).toEqual(["dispatch-retained"]);
		expect(summary).toMatchObject({
			canaryCampaignsExpired: 1,
			canaryDispatchesExpired: 1,
		});
	});
});

describe("Downloadable artifact object cleanup", () => {
	it("deletes an abandoned pending object and removes its ledger row", async () => {
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/abandoned",
			userId: "user-1",
			conversationId: "conv-gone",
			runId: "run-gone",
			path: "report.txt",
		});

		await pass();

		expect(artifactJanitor.deleted).toEqual(["objects/abandoned"]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
	});

	it("never deletes a currently referenced object regardless of lifecycle status", async () => {
		await insertConversation("user-1", "conv-live");
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/referenced",
			userId: "user-1",
			conversationId: "conv-live",
			runId: "run-gone",
			path: "report.txt",
			status: "pending",
		});
		await tdb.db.insert(conversationArtifacts).values({
			artifactId: "artifact-1",
			userId: "user-1",
			conversationId: "conv-live",
			path: "report.txt",
			objectKey: "objects/referenced",
			sizeBytes: 12,
			contentType: "text/plain",
		});

		await pass();

		expect(artifactJanitor.deleted).toEqual([]);
		expect(await tdb.db.select().from(artifactObjects)).toHaveLength(1);
	});

	it("deletes a pending object owned by a terminal Run", async () => {
		await insertConversation("user-1", "conv-gone");
		await tdb.db.insert(runs).values({
			runId: "run-terminal",
			userId: "user-1",
			conversationId: "conv-gone",
			status: "error",
			terminalAt: new Date("2026-07-16T00:00:00.000Z"),
		});
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/terminal",
			userId: "user-1",
			conversationId: "conv-gone",
			runId: "run-terminal",
			path: "report.txt",
		});

		await pass();

		expect(artifactJanitor.deleted).toEqual(["objects/terminal"]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
	});

	it("keeps a pending object until Reclamation terminalizes its Run", async () => {
		await insertConversation("user-1", "conv-gone");
		await tdb.db
			.update(conversations)
			.set({
				ownerWorkerId: "worker-gone",
				ownerUntil: new Date("2026-07-16T00:09:59.000Z"),
			})
			.where(eq(conversations.conversationId, "conv-gone"));
		await tdb.db.insert(runs).values({
			runId: "run-stale",
			userId: "user-1",
			conversationId: "conv-gone",
			status: "running",
			executedByWorkerId: "worker-gone",
		});
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/stale",
			userId: "user-1",
			conversationId: "conv-gone",
			runId: "run-stale",
			path: "report.txt",
		});

		await pass({ now: new Date("2026-07-16T00:10:00.000Z") });

		expect(artifactJanitor.deleted).toEqual([]);
		expect(await tdb.db.select().from(artifactObjects)).toHaveLength(1);
	});

	it("keeps a pending object while its owning Run is executing", async () => {
		await insertConversation("user-1", "conv-live");
		await tdb.db.insert(runs).values({
			runId: "run-active",
			userId: "user-1",
			conversationId: "conv-live",
			status: "running",
			executedByWorkerId: "worker-live",
		});
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/uploading",
			userId: "user-1",
			conversationId: "conv-live",
			runId: "run-active",
			path: "report.txt",
		});

		await pass({ now: new Date("2026-07-16T00:10:00.000Z") });

		expect(artifactJanitor.deleted).toEqual([]);
		expect(await tdb.db.select().from(artifactObjects)).toHaveLength(1);
	});

	it("deletes a superseded object once its ten-minute grace has elapsed", async () => {
		await insertConversation("user-1", "conv-live");
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/superseded",
			userId: "user-1",
			conversationId: "conv-live",
			runId: "run-old",
			path: "report.txt",
			status: "superseded",
			supersededAt: new Date("2026-07-16T00:00:00.000Z"),
		});

		await pass({ now: new Date("2026-07-16T00:10:00.000Z") });

		expect(artifactJanitor.deleted).toEqual(["objects/superseded"]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
	});

	it("keeps a superseded object until the full grace period elapses", async () => {
		await insertConversation("user-1", "conv-live");
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/still-graceful",
			userId: "user-1",
			conversationId: "conv-live",
			runId: "run-old",
			path: "report.txt",
			status: "superseded",
			supersededAt: new Date("2026-07-16T00:00:00.001Z"),
		});

		await pass({ now: new Date("2026-07-16T00:10:00.000Z") });

		expect(artifactJanitor.deleted).toEqual([]);
		expect(await tdb.db.select().from(artifactObjects)).toHaveLength(1);
	});

	it("waives supersession grace after the conversation is deleted", async () => {
		await insertConversation("user-1", "conv-delete");
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/recently-superseded",
			userId: "user-1",
			conversationId: "conv-delete",
			runId: "run-old",
			path: "report.txt",
			status: "superseded",
			supersededAt: new Date("2026-07-16T00:09:59.999Z"),
		});
		await tdb.db
			.delete(conversations)
			.where(eq(conversations.conversationId, "conv-delete"));

		await pass({ now: new Date("2026-07-16T00:10:00.000Z") });

		expect(artifactJanitor.deleted).toEqual(["objects/recently-superseded"]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
	});

	it("deletes a formerly current object after its conversation is deleted", async () => {
		await insertConversation("user-1", "conv-delete");
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/deleted-conversation",
			userId: "user-1",
			conversationId: "conv-delete",
			runId: "run-old",
			path: "report.txt",
			status: "current",
			committedAt: new Date("2026-07-16T00:00:00.000Z"),
		});
		await tdb.db.insert(conversationArtifacts).values({
			artifactId: "artifact-delete",
			userId: "user-1",
			conversationId: "conv-delete",
			path: "report.txt",
			objectKey: "objects/deleted-conversation",
			sizeBytes: 12,
			contentType: "text/plain",
		});

		await tdb.db
			.delete(conversations)
			.where(eq(conversations.conversationId, "conv-delete"));
		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);

		await pass();

		expect(artifactJanitor.deleted).toEqual(["objects/deleted-conversation"]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
	});

	it("retains failed deletes and retries them on a later pass", async () => {
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/flaky",
			userId: "user-1",
			conversationId: "conv-gone",
			runId: "run-gone",
			path: "report.txt",
		});
		artifactJanitor.deleteFailKeys.add("objects/flaky");

		const first = await pass();
		expect(first.artifactObjectsFailed).toBe(1);
		expect(await tdb.db.select().from(artifactObjects)).toHaveLength(1);

		artifactJanitor.deleteFailKeys.clear();
		const second = await pass();
		expect(second.artifactObjectsDeleted).toBe(1);
		expect(artifactJanitor.deleted).toEqual(["objects/flaky"]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
	});

	it("isolates a failing object from healthy objects in the same pass", async () => {
		await tdb.db.insert(artifactObjects).values([
			{
				objectKey: "objects/bad",
				userId: "user-1",
				conversationId: "conv-gone",
				runId: "run-gone",
				path: "bad.txt",
			},
			{
				objectKey: "objects/good",
				userId: "user-1",
				conversationId: "conv-gone",
				runId: "run-gone",
				path: "good.txt",
			},
		]);
		artifactJanitor.deleteFailKeys.add("objects/bad");

		const summary = await pass();

		expect(artifactJanitor.deleted).toEqual(["objects/good"]);
		expect(summary.artifactObjectsDeleted).toBe(1);
		expect(summary.artifactObjectsFailed).toBe(1);
		expect(
			(await tdb.db.select().from(artifactObjects)).map(
				(object) => object.objectKey,
			),
		).toEqual(["objects/bad"]);
	});
});

async function insertConversation(userId: string, conversationId: string) {
	await tdb.db
		.insert(conversations)
		.values({ userId, conversationId, scope: "general" });
}

async function insertRuntime(row: {
	userId: string;
	conversationId: string;
	sandboxId?: string | null;
}) {
	await tdb.db.insert(conversationRuntime).values(row);
}

async function insertOrphan(sandboxId: string, conversationId = "conv-x") {
	await tdb.db.insert(orphanSandboxes).values({
		sandboxId,
		userId: "user-1",
		conversationId,
		runId: "run-x",
		createdByWorkerId: "worker-old",
		reason: "test",
	});
}

async function orphanIds(): Promise<string[]> {
	const rows = await tdb.db
		.select({ id: orphanSandboxes.sandboxId })
		.from(orphanSandboxes);
	return rows.map((r) => r.id).sort();
}

async function runtimeRow(userId: string, conversationId: string) {
	const [row] = await tdb.db
		.select()
		.from(conversationRuntime)
		.where(
			and(
				eq(conversationRuntime.userId, userId),
				eq(conversationRuntime.conversationId, conversationId),
			),
		);
	return row;
}

describe("orphan sandbox cleanup", () => {
	it("never kills a sandbox still referenced by conversation_runtime", async () => {
		await insertConversation("user-1", "conv-1");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sbx-referenced",
		});
		await insertOrphan("sbx-referenced");

		const summary = await pass();

		expect(janitor.killed).toEqual([]);
		expect(await orphanIds()).toEqual(["sbx-referenced"]);
		expect(summary.orphanSandboxesSkippedReferenced).toBe(1);
		expect(summary.orphanSandboxesKilled).toBe(0);
	});

	it("kills an unreferenced orphan and removes its ledger row", async () => {
		await insertOrphan("sbx-orphan");

		const summary = await pass();

		expect(janitor.killed).toEqual(["sbx-orphan"]);
		expect(await orphanIds()).toEqual([]);
		expect(summary.orphanSandboxesKilled).toBe(1);
	});

	it("retries a failed kill: the ledger row survives, a later pass kills it", async () => {
		await insertOrphan("sbx-flaky");
		janitor.killFailIds.add("sbx-flaky");

		const first = await pass();
		expect(first.orphanSandboxesFailed).toBe(1);
		expect(await orphanIds()).toEqual(["sbx-flaky"]);

		janitor.killFailIds.clear();
		const second = await pass();
		expect(second.orphanSandboxesKilled).toBe(1);
		expect(await orphanIds()).toEqual([]);
	});

	it("isolates a failing orphan from a healthy one in the same pass", async () => {
		await insertOrphan("sbx-bad");
		await insertOrphan("sbx-good");
		janitor.killFailIds.add("sbx-bad");

		const summary = await pass();

		expect(janitor.killed).toEqual(["sbx-good"]);
		expect(await orphanIds()).toEqual(["sbx-bad"]);
		expect(summary.orphanSandboxesKilled).toBe(1);
		expect(summary.orphanSandboxesFailed).toBe(1);
	});
});

describe("deleted-conversation cleanup", () => {
	it("cleans retained AgentCore-canary resources without deleting its unexpired audit", async () => {
		await tdb.db.insert(canaryCampaigns).values({
			campaignId: "campaign-deleted-conversation",
			idempotencyKey: "key-deleted-conversation",
			campaignVersion: "v1",
			fixtureVersion: "fixture-v1",
			fixtureChecksum: "fixture-checksum",
			inputChecksum: "input-checksum",
			model: "model",
			scenarioId: "scenario",
			userId: "canary-user",
			conversationId: "canary-conversation-gone",
			runId: "canary-run-gone",
			messageId: "canary-message-gone",
			expiresAt: new Date("2026-08-15T00:00:00.000Z"),
		});
		await tdb.db.insert(canaryDispatchOutbox).values({
			dispatchId: "canary-dispatch-gone",
			campaignId: "campaign-deleted-conversation",
			scenarioId: "scenario",
			userId: "canary-user",
			conversationId: "canary-conversation-gone",
			runId: "canary-run-gone",
			executionLane: "agentcore_canary",
			expiresAt: new Date("2026-08-15T00:00:00.000Z"),
		});
		await insertRuntime({
			userId: "canary-user",
			conversationId: "canary-conversation-gone",
			sandboxId: "sbx-canary-gone",
		});
		await tdb.db.insert(agentSessions).values({
			conversationId: "canary-conversation-gone",
			projectKey: "p",
			sessionId: "canary-session",
			uuid: "canary-entry",
			entry: { type: "user", uuid: "canary-entry" },
		});
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/canary-deleted",
			userId: "canary-user",
			conversationId: "canary-conversation-gone",
			runId: "canary-run-gone",
			path: "report.txt",
			status: "current",
			committedAt: new Date("2026-08-13T00:00:00.000Z"),
		});
		janitor.killFailIds.add("sbx-canary-gone");

		await pass({ now: new Date("2026-08-14T00:00:00.000Z") });

		expect(
			await runtimeRow("canary-user", "canary-conversation-gone"),
		).toBeUndefined();
		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				conversationId: "canary-conversation-gone",
				projectKey: "p",
				sessionId: "canary-session",
			}),
		).toBeNull();
		expect(artifactJanitor.deleted).toEqual(["objects/canary-deleted"]);
		expect(await orphanIds()).toEqual(["sbx-canary-gone"]);
		expect(await tdb.db.select().from(canaryCampaigns)).toHaveLength(1);
		expect(await tdb.db.select().from(canaryDispatchOutbox)).toHaveLength(1);

		janitor.killFailIds.clear();
		await pass({ now: new Date("2026-08-14T00:00:01.000Z") });
		expect(janitor.killed).toEqual(["sbx-canary-gone"]);
		expect(await orphanIds()).toEqual([]);
	});

	it("kills the sandbox then removes the runtime row", async () => {
		// No conversations row => the conversation was deleted.
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-gone",
			sandboxId: "sbx-gone",
		});

		const summary = await pass();

		expect(janitor.killed).toEqual(["sbx-gone"]);
		expect(await runtimeRow("user-1", "conv-gone")).toBeUndefined();
		expect(summary.deletedRuntimesRemoved).toBe(1);
	});

	it("deletes the deleted conversation's transcripts and keeps a surviving conversation's", async () => {
		// A deleted conversation (no `conversations` row) with a stored transcript.
		await insertRuntime({ userId: "user-1", conversationId: "conv-gone" });
		await tdb.db.insert(agentSessions).values({
			conversationId: "conv-gone",
			projectKey: "p",
			sessionId: "sess-gone",
			uuid: "a",
			entry: { type: "user", uuid: "a" },
		});
		// A surviving conversation whose transcript must be untouched.
		await insertConversation("user-1", "conv-live");
		await insertRuntime({ userId: "user-1", conversationId: "conv-live" });
		await tdb.db.insert(agentSessions).values({
			conversationId: "conv-live",
			projectKey: "p",
			sessionId: "sess-live",
			uuid: "b",
			entry: { type: "user", uuid: "b" },
		});

		await pass();

		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				conversationId: "conv-gone",
				projectKey: "p",
				sessionId: "sess-gone",
			}),
		).toBeNull();
		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				conversationId: "conv-live",
				projectKey: "p",
				sessionId: "sess-live",
			}),
		).toHaveLength(1);
	});

	it("records an orphan and still clears the pointer when the kill fails", async () => {
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-gone",
			sandboxId: "sbx-stuck",
		});
		janitor.killFailIds.add("sbx-stuck");

		const summary = await pass();

		// Kill failed -> retry state recorded in the orphan ledger...
		expect(await orphanIds()).toEqual(["sbx-stuck"]);
		// ...so the runtime pointer may be cleared.
		expect(await runtimeRow("user-1", "conv-gone")).toBeUndefined();
		expect(summary.deletedRuntimesRemoved).toBe(1);
	});

	it("leaves runtime rows of still-existing conversations untouched", async () => {
		await insertConversation("user-1", "conv-live");
		await insertRuntime({
			userId: "user-1",
			conversationId: "conv-live",
			sandboxId: "sbx-live",
		});

		const summary = await pass();

		expect(janitor.killed).toEqual([]);
		expect(await runtimeRow("user-1", "conv-live")).toBeDefined();
		expect(summary.deletedRuntimesRemoved).toBe(0);
	});
});
