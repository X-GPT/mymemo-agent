import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createConversationRuntimeTx } from "@mymemo/agent-db/runtime-store";
import {
	artifactObjects,
	conversationArtifacts,
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import {
	createTestDatabase,
	seedQueuedRun,
	type TestDb,
} from "@mymemo/agent-db/testing";
import { createInMemoryLiveStreamRelay } from "@mymemo/live-text";
import { eq, sql } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import type { SupervisedQuery } from "../sdk/agent-stream";
import { createSdkRunProcessor } from "../sdk/run-processor";
import {
	withNoSessionMirrorEvidence,
	withSessionMirrorEvidence,
} from "../sdk/testing/session-mirror-fixtures";
import { createAgentCoreRunHarness } from "../testing/agentcore-run-harness";
import type { ArtifactManifestEntry } from "./artifact-manifest";
import {
	type ArtifactObjectStore,
	type ArtifactWorkspace,
	createArtifactPublisher,
	withArtifactPublication,
} from "./artifact-publication";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };
const encoder = new TextEncoder();
const MIB = 1_024 * 1_024;
const MAX_ARTIFACT_SIZE_BYTES = 100 * MIB;
const MAX_CONVERSATION_ARTIFACT_BYTES = 1_024 * MIB;

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
		{ body: Uint8Array; modifiedAt: string; sizeBytes: number }
	>();
	private captures = 0;
	private failAtCapture: number | null = null;

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
			sizeBytes: file.sizeBytes,
			modifiedAt: file.modifiedAt,
		}));
	}

	async openFile(
		entry: ArtifactManifestEntry,
	): Promise<ReadableStream<Uint8Array>> {
		const file = this.files.get(entry.path);
		if (!file) throw new Error(`missing fake file ${entry.path}`);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(file.body);
				controller.close();
			},
		});
	}
}

async function readStream(
	body: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	return new Uint8Array(await new Response(body).arrayBuffer());
}

function successfulQuery(onStart: () => void): SupervisedQuery {
	return {
		close() {},
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
		close() {},
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
	logger: WorkerLogger = silentLogger,
	objectKeyPrefix?: string,
) {
	const uploaded = new Map<string, Uint8Array>();
	const queries = new Map<string, SupervisedQuery>();
	let nextObject = 1;
	let nextArtifact = 1;
	const objectStore: ArtifactObjectStore = {
		async upload(input) {
			if (upload) await upload(input);
			else uploaded.set(input.objectKey, await readStream(input.body));
		},
	};
	const publisher = createArtifactPublisher({
		db: tdb.db,
		objectStore,
		...(objectKeyPrefix
			? { objectKeyPrefix }
			: { createObjectKey: () => `objects/key-${nextObject++}` }),
		createArtifactId: () => `artifact-${nextArtifact++}`,
	});
	const loop = createAgentCoreRunHarness({
		db: tdb.db,
		liveStreamRelay: createInMemoryLiveStreamRelay(),
		processor: createSdkRunProcessor({
			logger,
			startRunQuery: async (run, signal) => {
				const query = queries.get(run.runId);
				if (!query) throw new Error(`no fake query for ${run.runId}`);
				const publication = await publisher.begin({
					run,
					workspace,
					signal,
				});
				return withNoSessionMirrorEvidence(
					withArtifactPublication(query, publication),
				);
			},
		}),
		logger,
	});
	const worker = { drain: () => loop.drain() };
	return {
		loop,
		worker,
		uploaded,
		async queue(runId: string, query: SupervisedQuery) {
			queries.set(runId, query);
			await seedQueuedRun(tdb.db, {
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
		executionRuntime: "agentcore",
	});
}

async function insertCurrentArtifacts(
	artifacts: Array<{ path: string; sizeBytes: number }>,
): Promise<void> {
	await tdb.db.insert(conversationArtifacts).values(
		artifacts.map((artifact, index) => ({
			artifactId: `current-artifact-${index}`,
			userId: "user-1",
			conversationId: "conv-1",
			path: artifact.path,
			objectKey: `objects/current-${index}`,
			sizeBytes: artifact.sizeBytes,
			contentType: "application/octet-stream",
		})),
	);
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
	it("places generated object keys under the standard production namespace", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const harness = buildArtifactHarness(workspace);

		await harness.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("canary"), "1");
			}),
		);

		expect([...harness.uploaded.keys()]).toHaveLength(1);
		expect([...harness.uploaded.keys()][0]).toBe("objects/key-1");
	});

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
				uploaded.set(input.objectKey, await readStream(input.body));
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
		const loop = createAgentCoreRunHarness({
			db: tdb.db,
			liveStreamRelay: createInMemoryLiveStreamRelay(),
			processor: createSdkRunProcessor({
				logger: silentLogger,
				startRunQuery: async (run, signal, owner) => {
					await createConversationRuntimeTx(tdb.db, owner);
					const publication = await publisher.begin({
						run,
						workspace,
						signal,
					});
					return withSessionMirrorEvidence(
						withArtifactPublication(
							successfulQuery(() => {
								workspace.write("report.txt", encoder.encode("hello"), "2");
								workspace.write(
									"chart.bin",
									new Uint8Array([0, 255, 1, 254]),
									"2",
								);
							}),
							publication,
						),
						"session-1",
					);
				},
			}),
			logger: silentLogger,
		});

		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "agentcore",
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await loop.tick();
		await loop.drain();

		const artifacts = await tdb.db
			.select()
			.from(conversationArtifacts)
			.orderBy(conversationArtifacts.path);
		expect(
			artifacts.map(({ path, sizeBytes, contentType }) => ({
				path,
				sizeBytes,
				contentType,
			})),
		).toEqual([
			{
				path: "chart.bin",
				sizeBytes: 4,
				contentType: "application/octet-stream",
			},
			{ path: "report.txt", sizeBytes: 5, contentType: "text/plain" },
		]);
		expect([...uploaded.values()].map((body) => [...body])).toEqual([
			[0, 255, 1, 254],
			[104, 101, 108, 108, 111],
		]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("done");
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBe("session-1");
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

	it("detects size or timestamp changes but accepts the preserved-timestamp miss", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("v1"), "1");
			}),
		);
		await h.run(
			"run-2",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("v-two"), "1");
			}),
		);
		const afterSizeChange = (
			await tdb.db.select().from(conversationArtifacts)
		)[0]?.objectKey;
		await h.run(
			"run-3",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("other"), "2");
			}),
		);
		const afterTimestampChange = (
			await tdb.db.select().from(conversationArtifacts)
		)[0]?.objectKey;
		await h.run(
			"run-4",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("again"), "2");
			}),
		);

		expect(afterTimestampChange).not.toBe(afterSizeChange);
		expect(h.uploaded.size).toBe(3);
		expect(
			(await tdb.db.select().from(conversationArtifacts))[0]?.objectKey,
		).toBe(afterTimestampChange);
		expect(
			(await tdb.db.select().from(runs)).find((run) => run.runId === "run-4")
				?.status,
		).toBe("done");
	});

	it("keeps prior metadata hidden when an upload fails and does not advance continuity", async () => {
		await insertConversation();
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
		});
		const workspace = new FakeWorkspace();
		const errors: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			...silentLogger,
			error(event) {
				errors.push(event);
			},
		};
		const h = buildArtifactHarness(
			workspace,
			async () => {
				throw new Error(
					"https://storage.invalid/private?signature=secret objects/key body=secret",
				);
			},
			logger,
		);

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
			outcome: "error",
		});
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBeNull();
		expect(errors).toContainEqual(
			expect.objectContaining({
				artifactFailure: { category: "publication", stage: "upload" },
			}),
		);
		expect(JSON.stringify(errors)).not.toContain("storage.invalid");
		expect(JSON.stringify(errors)).not.toContain("objects/key");
		expect(JSON.stringify(errors)).not.toContain("body=secret");
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
			outcome: "error",
		});
	});

	it("rejects an oversized candidate before ledgering or upload", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const errors: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			...silentLogger,
			error(event) {
				errors.push(event);
			},
		};
		const h = buildArtifactHarness(workspace, undefined, logger);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write(
					"oversized.bin",
					new Uint8Array([1]),
					"1",
					MAX_ARTIFACT_SIZE_BYTES + 1,
				);
			}),
		);

		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect(h.uploaded.size).toBe(0);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
		expect(errors).toContainEqual(
			expect.objectContaining({
				artifactFailure: {
					category: "quota",
					quota: "artifact_size_bytes",
					actual: MAX_ARTIFACT_SIZE_BYTES + 1,
					limit: MAX_ARTIFACT_SIZE_BYTES,
				},
			}),
		);
	});

	it("rejects a 101st current path without changing the prior set", async () => {
		await insertConversation();
		await insertCurrentArtifacts(
			Array.from({ length: 100 }, (_, index) => ({
				path: `current-${index.toString().padStart(3, "0")}.txt`,
				sizeBytes: 1,
			})),
		);
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("new.txt", encoder.encode("new"), "1");
			}),
		);

		const current = await tdb.db.select().from(conversationArtifacts);
		expect(current).toHaveLength(100);
		expect(current.some((artifact) => artifact.path === "new.txt")).toBe(false);
		expect((await tdb.db.select().from(artifactObjects))[0]?.status).toBe(
			"pending",
		);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
	});

	it("rejects an aggregate overflow without exposing any file in a multi-file publication", async () => {
		await insertConversation();
		await insertCurrentArtifacts([
			...Array.from({ length: 10 }, (_, index) => ({
				path: `large-${index}.bin`,
				sizeBytes: MAX_ARTIFACT_SIZE_BYTES,
			})),
			{ path: "remainder.bin", sizeBytes: 24 * MIB },
		]);
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write(
					"large-0.bin",
					new Uint8Array([1]),
					"1",
					MAX_ARTIFACT_SIZE_BYTES,
				);
				workspace.write("new.txt", new Uint8Array([2]), "1");
			}),
		);

		const current = await tdb.db
			.select()
			.from(conversationArtifacts)
			.orderBy(conversationArtifacts.path);
		expect(current).toHaveLength(11);
		expect(
			current.find((artifact) => artifact.path === "large-0.bin")?.objectKey,
		).toBe("objects/current-0");
		expect(current.some((artifact) => artifact.path === "new.txt")).toBe(false);
		expect(
			(await tdb.db.select().from(artifactObjects)).map(({ status }) => status),
		).toEqual(["pending", "pending"]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
	});

	it("counts only the replacement at the aggregate quota ceiling", async () => {
		await insertConversation();
		await insertCurrentArtifacts([
			...Array.from({ length: 10 }, (_, index) => ({
				path: `large-${index}.bin`,
				sizeBytes: MAX_ARTIFACT_SIZE_BYTES,
			})),
			{
				path: "remainder.bin",
				sizeBytes:
					MAX_CONVERSATION_ARTIFACT_BYTES - 10 * MAX_ARTIFACT_SIZE_BYTES,
			},
		]);
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write(
					"large-0.bin",
					new Uint8Array([1]),
					"1",
					MAX_ARTIFACT_SIZE_BYTES,
				);
			}),
		);

		expect(
			(await tdb.db.select().from(conversationArtifacts)).find(
				(artifact) => artifact.path === "large-0.bin",
			)?.objectKey,
		).toBe("objects/key-1");
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("done");
	});

	it("validates every changed path before ledgering a multi-file publication", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const errors: Record<string, unknown>[] = [];
		const logger: WorkerLogger = {
			...silentLogger,
			error(event) {
				errors.push(event);
			},
		};
		const h = buildArtifactHarness(workspace, undefined, logger);

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("safe.txt", encoder.encode("safe"), "1");
				workspace.write("../escape.txt", encoder.encode("unsafe"), "1");
			}),
		);

		expect(await tdb.db.select().from(artifactObjects)).toEqual([]);
		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect(h.uploaded.size).toBe(0);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("error");
		expect(errors).toContainEqual(
			expect.objectContaining({
				artifactFailure: { category: "validation", reason: "invalid_path" },
			}),
		);
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
			outcome: "error",
		});
	});

	it("lets late interruption beat the atomic success commit", async () => {
		await insertConversation();
		const workspace = new FakeWorkspace();
		const h = buildArtifactHarness(workspace, async () => {
			await tdb.db
				.update(runs)
				.set({ status: "interrupt_requested" })
				.where(eq(runs.runId, "run-1"));
		});

		await h.run(
			"run-1",
			successfulQuery(() => {
				workspace.write("report.txt", encoder.encode("hello"), "1");
			}),
		);

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("interrupted");
		expect(
			(await tdb.db.select().from(runEvents)).map((event) => event.type),
		).toEqual(["run_interrupted"]);
	});

	it("aborts an in-progress upload when interruption is observed", async () => {
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
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));
		await h.loop.tick();
		await h.worker.drain();

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("interrupted");
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
			.update(conversations)
			.set({
				epoch: sql`${conversations.epoch} + 1`,
				ownerWorkerId: "worker-2",
				ownerUntil: new Date(Date.now() + 60_000),
			})
			.where(eq(conversations.conversationId, "conv-1"));
		await h.loop.tick();
		await h.worker.drain();

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect((await tdb.db.select().from(runs))[0]).toMatchObject({
			status: "running",
			executedByWorkerId: "worker-1",
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
			outcome: "error",
		});
	});
});
