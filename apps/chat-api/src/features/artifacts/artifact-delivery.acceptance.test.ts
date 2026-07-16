import { describe, expect, it } from "bun:test";
import { createQueuedRunTx } from "@mymemo/agent-db/run-store";
import { asc, eq } from "drizzle-orm";
import type { ApiConfig } from "@/config/env";
import {
	artifactObjects,
	conversationArtifacts,
	conversations,
	runEvents,
	runs,
} from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import type { AppDeps } from "@/deps";
import { PostgresConversationStore } from "@/features/conversation-store";
import { projectRunEvent } from "@/features/run-events/project-run-event";
import type { ArtifactManifestEntry } from "../../../../agent-worker/src/artifacts/artifact-manifest";
import {
	type ArtifactObjectStore,
	type ArtifactWorkspace,
	createArtifactPublisher,
	withArtifactPublication,
} from "../../../../agent-worker/src/artifacts/artifact-publication";
import { runCleanupPass } from "../../../../agent-worker/src/cleanup/cleanup";
import type { WorkerLogger } from "../../../../agent-worker/src/logger";
import { RunLoop } from "../../../../agent-worker/src/run-loop";
import type { SupervisedQuery } from "../../../../agent-worker/src/sdk/agent-stream";
import { createSdkRunProcessor } from "../../../../agent-worker/src/sdk/run-processor";
import { Worker } from "../../../../agent-worker/src/worker";
import type {
	ArtifactDownloadSigner,
	ArtifactDownloadSignInput,
} from "./artifact-download-signer";
import { PostgresArtifactMetadataStore } from "./postgres-artifact-metadata-store";

const { createApp } = await import("@/app");

const identityHeaders = {
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};
const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };
const encoder = new TextEncoder();

class AcceptanceWorkspace implements ArtifactWorkspace {
	private readonly files = new Map<
		string,
		{ body: Uint8Array; modifiedAt: string; sizeBytes: number }
	>();

	write(
		path: string,
		body: Uint8Array,
		modifiedAt: string,
		sizeBytes = body.byteLength,
	): void {
		this.files.set(path, { body, modifiedAt, sizeBytes });
	}

	delete(path: string): void {
		this.files.delete(path);
	}

	async captureManifest(): Promise<ArtifactManifestEntry[]> {
		return [...this.files].map(([path, file]) => ({
			path,
			sizeBytes: file.sizeBytes,
			modifiedAt: file.modifiedAt,
		}));
	}

	async openFile(
		entry: ArtifactManifestEntry,
	): Promise<ReadableStream<Uint8Array>> {
		const file = this.files.get(entry.path);
		if (!file) throw new Error(`missing acceptance file ${entry.path}`);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(file.body);
				controller.close();
			},
		});
	}
}

function successfulQuery(onStart: () => void): SupervisedQuery {
	return {
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			onStart();
			yield {
				type: "result",
				subtype: "success",
				is_error: false,
				result: "done",
				session_id: "acceptance-session",
			} as never;
		},
	};
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(body).arrayBuffer());
}

function createDeliveryHarness(
	tdb: TestDb,
	workspace: AcceptanceWorkspace,
	logger: WorkerLogger = silentLogger,
) {
	const storedObjects = new Map<string, Uint8Array>();
	let uploadOverride: ArtifactObjectStore["upload"] | undefined;
	let deleteOverride: ((objectKey: string) => Promise<void>) | undefined;
	let nextObject = 1;
	let nextArtifact = 1;
	const publisher = createArtifactPublisher({
		db: tdb.db,
		objectStore: {
			async upload(input) {
				if (uploadOverride) return await uploadOverride(input);
				storedObjects.set(input.objectKey, await readBody(input.body));
			},
		},
		createObjectKey: () => `objects/acceptance-${nextObject++}`,
		createArtifactId: () => `artifact-${nextArtifact++}`,
	});
	const worker = new Worker({
		workerId: "acceptance-worker",
		maxConcurrentRuns: 1,
		shutdownTimeoutMs: 1_000,
		logger,
	});
	const loop = new RunLoop({
		db: tdb.db,
		worker,
		processor: createSdkRunProcessor({
			logger,
			startRunQuery: async (run, signal) => {
				const query = queries.get(run.runId);
				if (!query) throw new Error(`missing query for ${run.runId}`);
				const publication = await publisher.begin({ run, workspace, signal });
				return withArtifactPublication(query, publication);
			},
		}),
		heartbeatIntervalMs: 15_000,
		logger,
	});
	const queries = new Map<string, SupervisedQuery>();

	return {
		loop,
		worker,
		storedObjects,
		setUploadOverride(override?: ArtifactObjectStore["upload"]) {
			uploadOverride = override;
		},
		setDeleteOverride(override?: (objectKey: string) => Promise<void>) {
			deleteOverride = override;
		},
		async queue(runId: string, query: SupervisedQuery) {
			queries.set(runId, query);
			await createQueuedRunTx(tdb.db, {
				runId,
				userId: "member-1",
				conversationId: "conversation-1",
			});
		},
		async run(runId: string, query: SupervisedQuery) {
			await this.queue(runId, query);
			await loop.tick();
			await worker.drain();
		},
		async cleanup(now: Date) {
			return await runCleanupPass({
				db: tdb.db,
				workerId: "acceptance-worker",
				now,
				logger,
				sandboxJanitor: { async killSandbox() {} },
				artifactJanitor: {
					async deleteObject(objectKey) {
						if (deleteOverride) await deleteOverride(objectKey);
						storedObjects.delete(objectKey);
					},
				},
			});
		},
	};
}

function createHttpHarness(tdb: TestDb) {
	const signInputs: ArtifactDownloadSignInput[] = [];
	const conversationStore = new PostgresConversationStore(tdb.db);
	const artifactDownloadSigner: ArtifactDownloadSigner = {
		async createDownloadUrl(input) {
			signInputs.push(input);
			return `https://objects.example/download-${signInputs.length}`;
		},
	};
	const deps = {
		conversationStore,
		artifactMetadataStore: new PostgresArtifactMetadataStore(tdb.db),
		artifactDownloadSigner,
		exposureGate: {
			async isAgentEnabled() {
				throw new Error("artifact reads must not consult the exposure gate");
			},
		},
	} as unknown as AppDeps;
	return {
		conversationStore,
		signInputs,
		app: createApp({ logLevel: "silent" } as ApiConfig, deps),
	};
}

async function currentArtifacts(tdb: TestDb) {
	return await tdb.db
		.select()
		.from(conversationArtifacts)
		.orderBy(asc(conversationArtifacts.path));
}

async function artifactList(app: ReturnType<typeof createApp>) {
	const response = await app.request(
		"/v1/conversations/conversation-1/artifacts",
		{ headers: identityHeaders },
	);
	return { response, body: await response.json() };
}

describe("Downloadable artifact delivery acceptance", () => {
	it("publishes a queued Run through Postgres, HTTP download, overwrite, cleanup, and deletion", async () => {
		const tdb = await createTestDatabase();
		try {
			const workspace = new AcceptanceWorkspace();
			const delivery = createDeliveryHarness(tdb, workspace);
			const http = createHttpHarness(tdb);
			await http.conversationStore.create({
				userId: "member-1",
				conversationId: "conversation-1",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});

			await delivery.run(
				"run-1",
				successfulQuery(() => {
					workspace.write(
						"charts/chart.bin",
						new Uint8Array([0, 255, 1, 254]),
						"1",
					);
					workspace.write("reports/report.txt", encoder.encode("v1"), "1");
				}),
			);

			const firstEvents = await tdb.db
				.select()
				.from(runEvents)
				.where(eq(runEvents.runId, "run-1"))
				.orderBy(asc(runEvents.seq));
			expect(firstEvents.map(({ type }) => type)).toEqual(["run_done"]);
			expect(
				firstEvents.flatMap(({ type, payload }) =>
					projectRunEvent(type, payload),
				),
			).toEqual([{ type: "done" }]);

			const firstCurrent = await currentArtifacts(tdb);
			const firstList = await artifactList(http.app);
			expect(firstList.response.status).toBe(200);
			expect(firstList.body).toEqual({
				artifacts: firstCurrent.map(
					({
						artifactId,
						path,
						sizeBytes,
						contentType,
						createdAt,
						updatedAt,
					}) => ({
						artifactId,
						path,
						sizeBytes,
						contentType,
						createdAt: createdAt.toISOString(),
						updatedAt: updatedAt.toISOString(),
					}),
				),
			});
			expect(JSON.stringify(firstList.body)).not.toContain("objectKey");
			expect(firstList.body).not.toHaveProperty("runId");

			const firstChart = firstCurrent.find(
				(artifact) => artifact.path === "charts/chart.bin",
			);
			expect(firstChart).toBeDefined();
			if (!firstChart) throw new Error("published chart is missing");
			const firstDownload = await http.app.request(
				`/v1/conversations/conversation-1/artifacts/${firstChart.artifactId}`,
				{ headers: identityHeaders },
			);
			expect(firstDownload.status).toBe(302);
			expect(firstDownload.headers.get("location")).toBe(
				"https://objects.example/download-1",
			);
			expect(http.signInputs[0]).toEqual({
				objectKey: firstChart.objectKey,
				expiresInSeconds: 300,
				responseContentDisposition:
					"attachment; filename=\"chart.bin\"; filename*=UTF-8''chart.bin",
				responseContentType: "application/octet-stream",
			});
			expect(delivery.storedObjects.get(firstChart.objectKey)).toEqual(
				new Uint8Array([0, 255, 1, 254]),
			);

			const firstReport = firstCurrent.find(
				(artifact) => artifact.path === "reports/report.txt",
			);
			expect(firstReport).toBeDefined();
			if (!firstReport) throw new Error("published report is missing");
			await delivery.run(
				"run-2",
				successfulQuery(() => {
					workspace.write("reports/report.txt", encoder.encode("v2"), "2");
				}),
			);
			const overwritten = (await currentArtifacts(tdb)).find(
				(artifact) => artifact.path === "reports/report.txt",
			);
			expect(overwritten).toMatchObject({
				artifactId: firstReport.artifactId,
				path: "reports/report.txt",
			});
			expect(overwritten?.objectKey).not.toBe(firstReport.objectKey);
			expect(overwritten?.createdAt).toEqual(firstReport.createdAt);
			expect(delivery.storedObjects.has(firstReport.objectKey)).toBe(true);

			const currentDownload = await http.app.request(
				`/v1/conversations/conversation-1/artifacts/${firstReport.artifactId}`,
				{ headers: identityHeaders },
			);
			expect(currentDownload.status).toBe(302);
			expect(http.signInputs.at(-1)?.objectKey).toBe(overwritten?.objectKey);
			const overwrittenList = await artifactList(http.app);
			expect(JSON.stringify(overwrittenList.body)).not.toContain(
				firstReport.objectKey,
			);

			const [superseded] = await tdb.db
				.select()
				.from(artifactObjects)
				.where(eq(artifactObjects.objectKey, firstReport.objectKey));
			expect(superseded?.status).toBe("superseded");
			expect(superseded?.supersededAt).not.toBeNull();
			const graceStarted = superseded?.supersededAt?.getTime() ?? 0;
			await delivery.cleanup(new Date(graceStarted + 10 * 60_000 - 1));
			expect(delivery.storedObjects.has(firstReport.objectKey)).toBe(true);
			await delivery.cleanup(new Date(graceStarted + 10 * 60_000));
			expect(delivery.storedObjects.has(firstReport.objectKey)).toBe(false);

			await delivery.cleanup(new Date("2100-01-01T00:00:00.000Z"));
			expect(delivery.storedObjects.has(firstChart.objectKey)).toBe(true);
			expect(delivery.storedObjects.has(overwritten?.objectKey ?? "")).toBe(
				true,
			);

			await tdb.db
				.delete(conversations)
				.where(eq(conversations.conversationId, "conversation-1"));
			const deletedList = await artifactList(http.app);
			expect(deletedList.response.status).toBe(404);
			expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
			await delivery.cleanup(new Date("2100-01-01T00:00:00.000Z"));
			expect(delivery.storedObjects.size).toBe(0);
			expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
		} finally {
			await tdb.close();
		}
	});

	it("keeps the prior current Downloadable artifact set intact across validation, quota, upload, cancellation, and cleanup failures", async () => {
		const tdb = await createTestDatabase();
		try {
			const logEvents: Record<string, unknown>[] = [];
			const logger: WorkerLogger = {
				info() {},
				warn(event) {
					logEvents.push(event);
				},
				error(event) {
					logEvents.push(event);
				},
			};
			const workspace = new AcceptanceWorkspace();
			const delivery = createDeliveryHarness(tdb, workspace, logger);
			const http = createHttpHarness(tdb);
			await http.conversationStore.create({
				userId: "member-1",
				conversationId: "conversation-1",
				scope: "general",
				collectionId: null,
				summaryId: null,
			});
			await delivery.run(
				"run-seed",
				successfulQuery(() => {
					workspace.write("report.txt", encoder.encode("current"), "1");
				}),
			);
			const priorList = (await artifactList(http.app)).body;
			const priorCurrent = await currentArtifacts(tdb);

			await delivery.run(
				"run-validation",
				successfulQuery(() => {
					workspace.write("../escape.txt", encoder.encode("unsafe"), "2");
				}),
			);
			workspace.delete("../escape.txt");

			await delivery.run(
				"run-quota",
				successfulQuery(() => {
					workspace.write(
						"oversized.bin",
						new Uint8Array([1]),
						"3",
						100 * 1_024 * 1_024 + 1,
					);
				}),
			);
			workspace.delete("oversized.bin");

			delivery.setUploadOverride(async () => {
				throw new Error(
					"https://storage.invalid/private?signature=secret bucket=private-artifacts",
				);
			});
			await delivery.run(
				"run-upload",
				successfulQuery(() => {
					workspace.write("upload.txt", encoder.encode("partial"), "4");
				}),
			);
			delivery.setUploadOverride();
			workspace.delete("upload.txt");

			let uploadStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				uploadStarted = resolve;
			});
			delivery.setUploadOverride(async ({ signal }) => {
				uploadStarted();
				await new Promise<never>((_resolve, reject) => {
					if (signal.aborted) return reject(new Error("upload aborted"));
					signal.addEventListener(
						"abort",
						() => reject(new Error("upload aborted")),
						{ once: true },
					);
				});
			});
			await delivery.queue(
				"run-cancel",
				successfulQuery(() => {
					workspace.write("cancel.txt", encoder.encode("partial"), "5");
				}),
			);
			await delivery.loop.tick();
			await started;
			await tdb.db
				.update(runs)
				.set({ status: "cancel_requested" })
				.where(eq(runs.runId, "run-cancel"));
			await delivery.loop.tick();
			await delivery.worker.drain();
			delivery.setUploadOverride();
			workspace.delete("cancel.txt");

			delivery.setDeleteOverride(async () => {
				throw new Error("delete temporarily unavailable");
			});
			const cleanup = await delivery.cleanup(
				new Date("2100-01-01T00:00:00.000Z"),
			);
			expect(cleanup.artifactObjectsFailed).toBe(2);

			expect((await artifactList(http.app)).body).toEqual(priorList);
			expect(await currentArtifacts(tdb)).toEqual(priorCurrent);
			const outcomes = await tdb.db
				.select({ runId: runs.runId, status: runs.status })
				.from(runs)
				.orderBy(asc(runs.createdAt));
			expect(outcomes).toEqual([
				{ runId: "run-seed", status: "done" },
				{ runId: "run-validation", status: "error" },
				{ runId: "run-quota", status: "error" },
				{ runId: "run-upload", status: "error" },
				{ runId: "run-cancel", status: "canceled" },
			]);
			const publicOutcomes = await tdb.db
				.select({ type: runEvents.type, payload: runEvents.payload })
				.from(runEvents)
				.orderBy(asc(runEvents.createdAt));
			expect(publicOutcomes).toEqual([
				{ type: "run_done", payload: {} },
				{ type: "run_error", payload: { message: "Run failed" } },
				{ type: "run_error", payload: { message: "Run failed" } },
				{ type: "run_error", payload: { message: "Run failed" } },
				{ type: "run_canceled", payload: {} },
			]);
			const serializedPublicState = JSON.stringify({
				list: priorList,
				outcomes: publicOutcomes,
			});
			expect(serializedPublicState).not.toContain("storage.invalid");
			expect(serializedPublicState).not.toContain("private-artifacts");
			expect(serializedPublicState).not.toContain("signature=secret");
			expect(JSON.stringify(logEvents)).not.toContain("storage.invalid");
			expect(JSON.stringify(logEvents)).not.toContain("signature=secret");
			expect(await tdb.db.select().from(artifactObjects)).toHaveLength(3);
		} finally {
			await tdb.close();
		}
	});
});
