import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { join } from "node:path";
import {
	artifactObjects,
	conversations,
	orphanSandboxes,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import {
	createTestDatabase,
	seedQueuedRun,
	type TestDb,
} from "@mymemo/agent-db/testing";
import { workspaceImportGraph } from "@mymemo/test-support/import-graph";
import { eq, sql } from "drizzle-orm";
import type {
	AdvisoryLockClient,
	AdvisoryLockPool,
} from "./cleanup/advisory-lock";
import type { SandboxJanitor } from "./cleanup/cleanup";
import type { WorkerLogger } from "./logger";
import { MaintenanceRunner } from "./maintenance-runner";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

class FakeJanitor implements SandboxJanitor {
	killed: string[] = [];
	async killSandbox(id: string): Promise<void> {
		this.killed.push(id);
	}
}

class FakeArtifactJanitor {
	deleted: string[] = [];
	async deleteObject(objectKey: string): Promise<void> {
		this.deleted.push(objectKey);
	}
}

class FakePool implements AdvisoryLockPool {
	constructor(private readonly failConnect = false) {}
	async connect(): Promise<AdvisoryLockClient> {
		if (this.failConnect) throw new Error("pool exhausted");
		return {
			async query(text: string) {
				return text.includes("pg_try_advisory_lock")
					? { rows: [{ locked: true }] }
					: { rows: [] };
			},
			release() {},
		};
	}
}

let tdb: TestDb;
let janitor: FakeJanitor;
let artifactJanitor: FakeArtifactJanitor;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(artifactObjects);
	await tdb.db.delete(orphanSandboxes);
	await tdb.db.delete(runs);
	await tdb.db.delete(conversations);
	janitor = new FakeJanitor();
	artifactJanitor = new FakeArtifactJanitor();
});

function buildRunner(
	overrides: {
		pool?: AdvisoryLockPool;
		telemetry?: { record(...args: unknown[]): void };
		logger?: WorkerLogger;
	} = {},
) {
	return new MaintenanceRunner({
		db: tdb.db,
		pool: overrides.pool ?? new FakePool(),
		sandboxJanitor: janitor,
		artifactJanitor,
		workerId: "worker-1",
		cleanupIntervalMs: 60_000,
		logger: overrides.logger ?? silentLogger,
		liveStreamTelemetry: overrides.telemetry,
	});
}

async function seedConversationRun(input: {
	conversationId: string;
	runId: string;
	status: "queued" | "running";
}) {
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: input.conversationId,
		scope: "general",
		...(input.status === "running"
			? {
					ownerWorkerId: "vanished-runtime",
					ownerUntil: new Date(Date.now() - 1_000),
					epoch: 1,
				}
			: {}),
	});
	await seedQueuedRun(tdb.db, {
		runId: input.runId,
		userId: "user-1",
		conversationId: input.conversationId,
	});
	await tdb.db
		.update(runs)
		.set({
			status: input.status,
			...(input.status === "queued"
				? {
						createdAt: sql`now() - interval '11 minutes'`,
						updatedAt: sql`now() - interval '11 minutes'`,
					}
				: { executedByWorkerId: "vanished-runtime" }),
		})
		.where(eq(runs.runId, input.runId));
}

describe("MaintenanceRunner", () => {
	it("logs a heartbeat after a successful liveness pass with no work", async () => {
		const messages: unknown[] = [];

		await buildRunner({
			logger: {
				info: ({ message }) => messages.push(message),
				warn() {},
				error() {},
			},
		}).runLivenessOnce();

		expect(messages).toEqual(["maintenance liveness pass complete"]);
	});

	it("expires queued Runs and reclaims lapsed Ownership without serving Runs", async () => {
		await seedConversationRun({
			conversationId: "conv-queued",
			runId: "run-queued",
			status: "queued",
		});
		await seedConversationRun({
			conversationId: "conv-lapsed",
			runId: "run-lapsed",
			status: "running",
		});
		const metrics: unknown[][] = [];
		const runner = buildRunner({
			telemetry: { record: (...args) => metrics.push(args) },
		});

		await runner.runLivenessOnce();

		const rows = await tdb.db
			.select({ runId: runs.runId, status: runs.status })
			.from(runs);
		expect(rows.sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
			{ runId: "run-lapsed", status: "error" },
			{ runId: "run-queued", status: "error" },
		]);
		expect(
			(await tdb.db.select().from(runEvents)).map((event) => event.type),
		).toEqual(["run_error", "run_error"]);
		expect(metrics.map(([operation, result]) => [operation, result])).toEqual([
			["degradation", "started"],
			["degradation", "ended"],
		]);
	});

	it("runs cleanup under the existing advisory lock", async () => {
		await tdb.db.insert(orphanSandboxes).values({
			sandboxId: "sbx-orphan",
			userId: "user-1",
			conversationId: "conv-gone",
			runId: "run-gone",
			createdByWorkerId: "worker-old",
			reason: "test",
		});
		await tdb.db.insert(artifactObjects).values({
			objectKey: "objects/abandoned",
			userId: "user-1",
			conversationId: "conv-gone",
			runId: "run-gone",
			path: "report.txt",
		});

		const summary = await buildRunner().runCleanupOnce();

		expect(summary?.orphanSandboxesKilled).toBe(1);
		expect(janitor.killed).toEqual(["sbx-orphan"]);
		expect(artifactJanitor.deleted).toEqual(["objects/abandoned"]);
	});

	it("isolates cleanup lock failures for retry on the next interval", async () => {
		const summary = await buildRunner({
			pool: new FakePool(true),
		}).runCleanupOnce();

		expect(summary).toBeUndefined();
		expect(janitor.killed).toEqual([]);
	});

	it("starts liveness immediately and stops before delayed cleanup", async () => {
		await seedConversationRun({
			conversationId: "conv-queued",
			runId: "run-queued",
			status: "queued",
		});
		await tdb.db.insert(orphanSandboxes).values({
			sandboxId: "sbx-delayed",
			userId: "user-1",
			conversationId: "conv-gone",
			runId: "run-gone",
			createdByWorkerId: "worker-old",
			reason: "test",
		});
		const runner = buildRunner();

		await runner.start();
		runner.stop();

		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
		expect(janitor.killed).toEqual([]);
	});
});

describe("MaintenanceRunner import boundary", () => {
	it("loads maintenance capabilities without Run-serving dependencies", () => {
		const root = join(import.meta.dir, "../../..");
		const graph = [
			...workspaceImportGraph(
				root,
				join(import.meta.dir, "maintenance-runner.ts"),
			),
		];
		for (const forbidden of [
			"/packages/agent-worker/src/run-loop.ts",
			"/packages/agent-worker/src/run-serving.ts",
			"/packages/agent-worker/src/model-client.ts",
			"/packages/agent-worker/src/documents/",
			"/packages/agent-worker/src/sdk/",
			"/packages/live-text/",
			"/packages/agentcore-dispatch/",
		]) {
			expect(graph.some((file) => file.includes(forbidden))).toBe(false);
		}
	});
});
