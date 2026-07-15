import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createQueuedRunTx } from "@mymemo/agent-db/run-store";
import {
	artifactObjects,
	conversationArtifacts,
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { eq } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import { RunLoop } from "../run-loop";
import type { SupervisedQuery } from "../sdk/agent-stream";
import { createSdkRunProcessor } from "../sdk/run-processor";
import { Worker } from "../worker";
import {
	type ArtifactObjectStore,
	type ArtifactWorkspace,
	createArtifactPublisher,
	withArtifactPublication,
} from "./artifact-publication";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };
const encoder = new TextEncoder();

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(artifactObjects);
	await tdb.db.delete(runs);
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
});

class FakeWorkspace implements ArtifactWorkspace {
	private readonly files = new Map<
		string,
		{ body: Uint8Array; modifiedAt: string }
	>();
	private captures = 0;
	private failAtCapture: number | null = null;

	write(path: string, body: Uint8Array, modifiedAt: string): void {
		this.files.set(path, { body, modifiedAt });
	}

	delete(path: string): void {
		this.files.delete(path);
	}

	failCapture(number: number): void {
		this.failAtCapture = number;
	}

	async captureManifest() {
		this.captures++;
		if (this.failAtCapture === this.captures) {
			throw new Error("manifest unavailable");
		}
		return [...this.files].map(([path, file]) => ({
			path,
			sizeBytes: file.body.byteLength,
			modifiedAt: file.modifiedAt,
		}));
	}

	async readFile(path: string): Promise<Uint8Array> {
		const file = this.files.get(path);
		if (!file) throw new Error(`missing fake file ${path}`);
		return file.body;
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
				session_id: "session-1",
			} as unknown as SDKMessage;
		},
	};
}

function failedQuery(onStart: () => void, error: Error): SupervisedQuery {
	return {
		async interrupt() {},
		// biome-ignore lint/correctness/useYield: the fixture fails before producing an SDK message.
		async *[Symbol.asyncIterator]() {
			onStart();
			throw error;
		},
	};
}

function buildArtifactHarness(
	workspace: FakeWorkspace,
	upload?: ArtifactObjectStore["upload"],
) {
	const uploaded = new Map<string, Uint8Array>();
	const queries = new Map<string, SupervisedQuery>();
	let nextObject = 1;
	let nextArtifact = 1;
	const objectStore: ArtifactObjectStore = {
		async upload(input) {
			if (upload) await upload(input);
			else uploaded.set(input.objectKey, input.body);
		},
	};
	const publisher = createArtifactPublisher({
		db: tdb.db,
		objectStore,
		createObjectKey: () => `objects/key-${nextObject++}`,
		createArtifactId: () => `artifact-${nextArtifact++}`,
	});
	const worker = new Worker({
		workerId: "worker-1",
		maxConcurrentRuns: 1,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
	const loop = new RunLoop({
		db: tdb.db,
		worker,
		processor: createSdkRunProcessor({
			logger: silentLogger,
			startRunQuery: async (run, signal) => {
				const query = queries.get(run.runId);
				if (!query) throw new Error(`no fake query for ${run.runId}`);
				const publication = await publisher.begin({
					run,
					workspace,
					signal,
				});
				return withArtifactPublication(query, publication);
			},
		}),
		heartbeatIntervalMs: 15_000,
		logger: silentLogger,
	});
	return {
		loop,
		worker,
		uploaded,
		async queue(runId: string, query: SupervisedQuery) {
			queries.set(runId, query);
			await createQueuedRunTx(tdb.db, {
				runId,
				userId: "user-1",
				conversationId: "conv-1",
			});
		},
		async run(runId: string, query: SupervisedQuery) {
			await this.queue(runId, query);
			await loop.tick();
			await worker.drain();
		},
	};
}

async function insertConversation(): Promise<void> {
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conv-1",
		scope: "general",
	});
}

function blockingUpload() {
	let announceStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		announceStarted = resolve;
	});
	const upload: ArtifactObjectStore["upload"] = async ({ signal }) => {
		announceStarted();
		await new Promise<never>((_resolve, reject) => {
			if (signal.aborted) return reject(new Error("upload aborted"));
			signal.addEventListener(
				"abort",
				() => reject(new Error("upload aborted")),
				{ once: true },
			);
		});
	};
	return { upload, started };
}

describe("Downloadable artifact publication through the Run loop", () => {
	it("publishes text and binary files before run_done becomes visible", async () => {
		const workspace = new FakeWorkspace();
		const uploaded = new Map<string, Uint8Array>();
		const objectStore: ArtifactObjectStore = {
			async upload(input) {
				const ledger = await tdb.db
					.select()
					.from(artifactObjects)
					.where(eq(artifactObjects.objectKey, input.objectKey));
				expect(ledger[0]?.status).toBe("pending");
				uploaded.set(input.objectKey, input.body);
			},
		};
		let nextObject = 1;
		let nextArtifact = 1;
		const publisher = createArtifactPublisher({
			db: tdb.db,
			objectStore,
			createObjectKey: () => `objects/key-${nextObject++}`,
			createArtifactId: () => `artifact-${nextArtifact++}`,
		});
		const worker = new Worker({
			workerId: "worker-1",
			maxConcurrentRuns: 1,
			shutdownTimeoutMs: 1_000,
			logger: silentLogger,
		});
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			processor: createSdkRunProcessor({
				logger: silentLogger,
				startRunQuery: async (run, signal) => {
					const publication = await publisher.begin({
						run,
						workspace,
						signal,
					});
					return withArtifactPublication(
						successfulQuery(() => {
							workspace.write("report.txt", encoder.encode("hello"), "2");
							workspace.write(
								"chart.bin",
								new Uint8Array([0, 255, 1, 254]),
								"2",
							);
						}),
						publication,
					);
				},
			}),
			heartbeatIntervalMs: 15_000,
			logger: silentLogger,
		});

		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
		});
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await worker.drain();

		const artifacts = await tdb.db
			.select()
			.from(conversationArtifacts)
			.orderBy(conversationArtifacts.path);
		expect(
			artifacts.map(({ path, sizeBytes }) => ({ path, sizeBytes })),
		).toEqual([
			{ path: "chart.bin", sizeBytes: 4 },
			{ path: "report.txt", sizeBytes: 5 },
		]);
		expect([...uploaded.values()].map((body) => [...body])).toEqual([
			[0, 255, 1, 254],
			[104, 101, 108, 108, 111],
		]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("done");
		expect(
			(await tdb.db.select().from(runEvents)).map((event) => event.type),
		).toEqual(["run_done"]);
	});

	it("preserves current identity while suppressing unchanged, missing, and failed leftovers", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("v1"), "1");
			}),
		);
		const [first] = await tdb.db.select().from(conversationArtifacts);

		await h.run(
			"run-2",
			successfulQuery(() => {}),
		);
		expect(h.uploaded.size).toBe(1);
		expect(await tdb.db.select().from(artifactObjects)).toHaveLength(1);

		await h.run(
			"run-3",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("v2"), "2");
			}),
		);
		const [updated] = await tdb.db.select().from(conversationArtifacts);
		expect(updated?.artifactId).toBe(first?.artifactId);
		expect(updated?.createdAt).toEqual(first?.createdAt);
		expect(updated?.objectKey).not.toBe(first?.objectKey);
		expect(h.uploaded.size).toBe(2);

		await h.run(
			"run-4",
			successfulQuery(() => {
				workspace.delete("report.txt");
			}),
		);
		expect(
			(await tdb.db.select().from(conversationArtifacts))[0]?.objectKey,
		).toBe(updated?.objectKey);

		await h.run(
			"run-5",
			failedQuery(() => {
				workspace.write("leftover.txt", encoder.encode("partial"), "3");
			}, new Error("model failed")),
		);
		await h.run(
			"run-6",
			successfulQuery(() => {}),
		);

		expect(
			(await tdb.db.select().from(conversationArtifacts)).map(
				({ path }) => path,
			),
		).toEqual(["report.txt"]);
		expect(h.uploaded.size).toBe(2);
		expect(
			(await tdb.db.select().from(runs)).find((run) => run.runId === "run-5")
				?.status,
		).toBe("error");
	});

	it("keeps prior metadata hidden when an upload fails and does not advance continuity", async () => {
		await insertConversation();
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
		});
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace, async () => {
			throw new Error("object store unavailable");
		});

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(artifactObjects))[0]?.status).toBe(
			"pending",
		);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
		expect((await tdb.db.select().from(runEvents))[0]?.payload).toEqual({
			message: "Run failed",
		});
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBeNull();
	});

	it("maps a final-manifest failure to the generic error without ledgering objects", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		workspace.failCapture(2);
		const h = buildArtifactHarness(workspace);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
		expect((await tdb.db.select().from(runEvents))[0]?.payload).toEqual({
			message: "Run failed",
		});
	});

	it("rolls back uploaded metadata when the lifecycle ledger cannot be committed", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace, async (input) => {
			await tdb.db
				.delete(artifactObjects)
				.where(eq(artifactObjects.objectKey, input.objectKey));
		});

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
		expect((await tdb.db.select().from(runEvents))[0]?.payload).toEqual({
			message: "Run failed",
		});
	});

	it("lets late cancellation beat the atomic success commit", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace, async () => {
			await tdb.db
				.update(runs)
				.set({ status: "cancel_requested" })
				.where(eq(runs.runId, "run-1"));
		});

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("canceled");
		expect(
			(await tdb.db.select().from(runEvents)).map((event) => event.type),
		).toEqual(["run_canceled"]);
	});

	it("aborts an in-progress upload when cancellation is observed", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const blocked = blockingUpload();
		const h = buildArtifactHarness(workspace, blocked.upload);
		await h.queue(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		await h.loop.tick();
		await blocked.started;
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));
		await h.loop.tick();
		await h.worker.drain();

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("canceled");
		expect((await tdb.db.select().from(artifactObjects))[0]?.status).toBe(
			"pending",
		);
	});

	it("abandons staged objects without terminalizing after ownership loss", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const blocked = blockingUpload();
		const h = buildArtifactHarness(workspace, blocked.upload);
		await h.queue(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		await h.loop.tick();
		await blocked.started;
		await tdb.db
			.update(runs)
			.set({
				lockedBy: "worker-2",
				lockedUntil: new Date(Date.now() + 60_000),
			})
			.where(eq(runs.runId, "run-1"));
		await h.loop.tick();
		await h.worker.drain();

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]).toMatchObject({
			status: "running",
			lockedBy: "worker-2",
		});
		expect(await tdb.db.select().from(runEvents)).toEqual([]);
	});

	it("aborts publication during worker shutdown and ends with the generic error", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const blocked = blockingUpload();
		const h = buildArtifactHarness(workspace, blocked.upload);
		await h.queue(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		await h.loop.tick();
		await blocked.started;
		await h.loop.stop();

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
		expect((await tdb.db.select().from(runEvents))[0]?.payload).toEqual({
			message: "Run failed",
		});
	});
});
