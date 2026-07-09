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
	conversationRuntime,
	conversations,
	orphanSandboxes,
} from "@mymemo/agent-db/schema";
import {
	appendAgentSessionEntriesTx,
	loadAgentSessionEntriesTx,
} from "@mymemo/agent-db/session-store";
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

let tdb: TestDb;
let janitor: FakeJanitor;

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
});

afterEach(async () => {
	await tdb.db.delete(orphanSandboxes);
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
	await tdb.db.delete(agentSessions);
});

function pass(overrides?: Partial<CleanupPassOptions>) {
	return runCleanupPass({
		db: tdb.db,
		janitor,
		workerId: "worker-1",
		logger: silentLogger,
		...overrides,
	});
}

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
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ conversationId: "conv-gone", projectKey: "p", sessionId: "sess-gone" },
			[{ type: "user", uuid: "a" }],
		);
		// A surviving conversation whose transcript must be untouched.
		await insertConversation("user-1", "conv-live");
		await insertRuntime({ userId: "user-1", conversationId: "conv-live" });
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ conversationId: "conv-live", projectKey: "p", sessionId: "sess-live" },
			[{ type: "user", uuid: "b" }],
		);

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
