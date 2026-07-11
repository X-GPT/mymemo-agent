import { expect, it } from "bun:test";
import { createServer } from "node:net";
import { createRedisLiveTextTransport } from "@mymemo/live-text";
import { eq } from "drizzle-orm";
import { runEvents, runs } from "@/db/schema";
import { createTestDatabase } from "@/db/testing";
import { createQueuedRunStartedTx } from "@/features/run-store";
import type { WorkerLogger } from "../../../../agent-worker/src/logger";
import { RunLoop } from "../../../../agent-worker/src/run-loop";
import type { SupervisedQuery } from "../../../../agent-worker/src/sdk/agent-stream";
import { createSdkRunProcessor } from "../../../../agent-worker/src/sdk/run-processor";
import {
	assistantBlock,
	streamEvent,
} from "../../../../agent-worker/src/sdk/testing/sdk-message-fixtures";
import { Worker } from "../../../../agent-worker/src/worker";
import { type ProjectedFrame, projectRun } from "./project-run";
import { DrizzleRunEventReader } from "./run-event-reader";
import { RunEventType } from "./run-event-types";
import type { RunNotifier, RunSubscription } from "./run-notifier";

class PollingNotifier implements RunNotifier {
	async subscribe(): Promise<RunSubscription> {
		return {
			waitForWakeup: async () => Bun.sleep(10),
			close: async () => {},
		};
	}
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function controlledTextQuery(options: {
	continueAfterFirstDelta: Promise<void>;
	continueAfterSecondDelta: Promise<void>;
}): SupervisedQuery {
	const query = {
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			yield streamEvent({
				type: "message_start",
				message: { id: "provider-message-1", content: [] },
			});
			yield streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			});
			yield streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hel" },
			});
			await options.continueAfterFirstDelta;
			yield streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "lo" },
			});
			await options.continueAfterSecondDelta;
			yield assistantBlock("provider-message-1", {
				type: "text",
				text: "hello",
			});
			yield streamEvent({ type: "content_block_stop", index: 0 });
			yield streamEvent({ type: "message_stop" });
		},
	};
	return query;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate Redis test port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

type RedisProcess = ReturnType<typeof Bun.spawn>;

async function waitUntil(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await Bun.sleep(20);
	}
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		Bun.sleep(3_000).then(() => {
			throw new Error(`${label} timed out`);
		}),
	]);
}

async function startRedis(port: number): Promise<RedisProcess> {
	const process = Bun.spawn(
		[
			"redis-server",
			"--bind",
			"127.0.0.1",
			"--port",
			String(port),
			"--save",
			"",
			"--appendonly",
			"no",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await waitUntil(async () => {
		const ping = Bun.spawn(
			["redis-cli", "-h", "127.0.0.1", "-p", String(port), "ping"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		return (await ping.exited) === 0;
	});
	return process;
}

async function stopRedis(process: RedisProcess): Promise<void> {
	if (process.exitCode !== null) return;
	process.kill("SIGTERM");
	await process.exited;
}

async function consumeRemaining(
	iterator: AsyncIterator<ProjectedFrame>,
): Promise<ProjectedFrame[]> {
	const projected: ProjectedFrame[] = [];
	for (;;) {
		const next = await iterator.next();
		if (next.done) return projected;
		projected.push(next.value);
	}
}

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

async function runWorkerThroughRedis(options: {
	stopAfterFirstDelta: boolean;
}) {
	const tdb = await createTestDatabase();
	const port = await freePort();
	const redis = await startRedis(port);
	const url = `redis://127.0.0.1:${port}`;
	const workerTransport = createRedisLiveTextTransport({
		url,
		operationTimeoutMs: 250,
	});
	const chatApiTransport = createRedisLiveTextTransport({ url });
	const firstDeltaObserved = deferred();
	const secondDeltaMayFinish = deferred();
	const publisherFailed = deferred();
	const logger: WorkerLogger = {
		...silentLogger,
		warn(event) {
			if (event.signal === "dropped" && event.reason === "publisher") {
				publisherFailed.resolve();
			}
		},
	};

	try {
		await createQueuedRunStartedTx(tdb.db, {
			runId: "run-1",
			conversation: {
				userId: "user-1",
				conversationId: "conversation-1",
				scope: "general",
				collectionId: null,
				summaryId: null,
			},
			message: "hello",
		});

		const liveSubscription = await chatApiTransport.subscribe("run-1");
		const notifier = new PollingNotifier();
		const iterator = projectRun("run-1", 0, {
			reader: new DrizzleRunEventReader(tdb.db),
			notifier,
			liveSubscription,
		})[Symbol.asyncIterator]();
		const projected: ProjectedFrame[] = [];
		projected.push(
			(await within(iterator.next(), "conversation frame"))
				.value as ProjectedFrame,
		);
		projected.push(
			(await within(iterator.next(), "Run frame")).value as ProjectedFrame,
		);

		const worker = new Worker({
			workerId: "worker-1",
			maxConcurrentRuns: 1,
			shutdownTimeoutMs: 1_000,
			logger,
		});
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			processor: createSdkRunProcessor({
				startRunQuery: async () =>
					controlledTextQuery({
						continueAfterFirstDelta: firstDeltaObserved.promise,
						continueAfterSecondDelta: secondDeltaMayFinish.promise,
					}),
				logger,
				liveTextPublisher: workerTransport,
			}),
			heartbeatIntervalMs: 15_000,
			logger,
		});

		await loop.tick();
		projected.push(
			(await within(iterator.next(), "first Live delta"))
				.value as ProjectedFrame,
		);
		if (options.stopAfterFirstDelta) await stopRedis(redis);
		firstDeltaObserved.resolve();

		if (options.stopAfterFirstDelta) {
			await within(publisherFailed.promise, "failed Redis publication");
			secondDeltaMayFinish.resolve();
		} else {
			projected.push(
				(await within(iterator.next(), "second Live delta"))
					.value as ProjectedFrame,
			);
			secondDeltaMayFinish.resolve();
		}

		await within(worker.drain(), "worker drain");
		const durableRows = await tdb.db
			.select()
			.from(runEvents)
			.where(eq(runEvents.runId, "run-1"))
			.orderBy(runEvents.seq);
		if (durableRows.at(-1)?.type !== RunEventType.Done) {
			throw new Error(
				`worker did not terminalize done: ${durableRows.map((row) => row.type).join(",")}`,
			);
		}
		projected.push(
			...(await within(consumeRemaining(iterator), "durable projection")),
		);

		const [run] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-1"));
		return { projected, run, events: durableRows };
	} finally {
		firstDeltaObserved.resolve();
		secondDeltaMayFinish.resolve();
		publisherFailed.resolve();
		await Promise.all([workerTransport.close(), chatApiTransport.close()]);
		await stopRedis(redis);
		await tdb.close();
	}
}

it("runs worker publication through Redis into cursorless preview and an exact durable commit", async () => {
	const { projected, run, events } = await runWorkerThroughRedis({
		stopAfterFirstDelta: false,
	});
	const [conversation, runFrame, firstDelta, secondDelta, commit, done] =
		projected;
	if (firstDelta?.frame.type !== "text_delta") {
		throw new Error("expected the first worker preview delta");
	}
	expect(conversation).toMatchObject({
		id: undefined,
		frame: { type: "conversation_id", conversationId: "conversation-1" },
	});
	expect(runFrame).toMatchObject({
		id: "1",
		frame: { type: "run_id", runId: "run-1" },
	});
	expect(firstDelta.id).toBeUndefined();
	expect(firstDelta.frame).toMatchObject({
		type: "text_delta",
		deltaIndex: 0,
		text: "hel",
	});
	expect(secondDelta?.id).toBeUndefined();
	expect(secondDelta?.frame).toMatchObject({
		type: "text_delta",
		deltaIndex: 1,
		text: "lo",
	});
	expect(commit).toMatchObject({
		id: "2",
		frame: {
			type: "text_commit",
			messageId: firstDelta.frame.messageId,
			text: "hello",
		},
	});
	expect(done).toMatchObject({ id: "3", frame: { type: "done" } });
	expect(run?.status).toBe("done");
	expect(events.map((event) => event.type)).toEqual([
		RunEventType.Started,
		RunEventType.AssistantText,
		RunEventType.Done,
	]);
}, 20_000);

it("keeps the active Run done from Postgres when Redis fails on its next publication", async () => {
	const { projected, run, events } = await runWorkerThroughRedis({
		stopAfterFirstDelta: true,
	});
	const deltas = projected.filter(({ frame }) => frame.type === "text_delta");
	const commit = projected.find(({ frame }) => frame.type === "text_commit");
	expect(deltas).toHaveLength(1);
	const firstDelta = deltas[0];
	if (firstDelta?.frame.type !== "text_delta") {
		throw new Error("expected one surviving worker preview delta");
	}
	expect(firstDelta.id).toBeUndefined();
	expect(firstDelta.frame).toMatchObject({
		type: "text_delta",
		deltaIndex: 0,
		text: "hel",
	});
	expect(commit).toMatchObject({
		id: "2",
		frame: {
			type: "text_commit",
			messageId: firstDelta.frame.messageId,
			text: "hello",
		},
	});
	expect(projected.at(-1)).toMatchObject({
		id: "3",
		frame: { type: "done" },
	});
	expect(projected.some(({ frame }) => frame.type === "error")).toBe(false);
	expect(run?.status).toBe("done");
	expect(events.at(-2)?.payload).toMatchObject({ text: "hello" });
	expect(events.at(-1)?.type).toBe(RunEventType.Done);
}, 20_000);
