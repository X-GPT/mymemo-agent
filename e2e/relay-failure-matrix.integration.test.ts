/**
 * ADR-0014 cross-service verification matrix.
 *
 * The production worker RunLoop and chat-api routes share one PGlite database
 * while separate relay instances communicate through a disposable real Redis.
 * Tests observe only HTTP/SSE, durable Conversation history, and Run state.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { parseAgUiSse } from "@mymemo/test-support/ag-ui-sse";
import {
	findFreePort,
	type RedisTestServer,
	startRedisTestServer,
} from "@mymemo/test-support/redis-test-server";
import type { WorkerLogger } from "../apps/agent-worker/src/logger";
import { RunLoop, type RunProcessor } from "../apps/agent-worker/src/run-loop";
import { Worker } from "../apps/agent-worker/src/worker";
import type { ApiConfig } from "../apps/chat-api/src/config/env";
import type { AppDeps } from "../apps/chat-api/src/deps";
import { PostgresConversationHistoryStore } from "../apps/chat-api/src/features/conversation-history";
import { PostgresConversationStore } from "../apps/chat-api/src/features/conversation-store";
import { PostgresRunStore } from "../apps/chat-api/src/features/run-store";
import {
	conversationRuntime,
	conversations,
	runs,
} from "../packages/agent-db/src/schema";
import {
	createTestDatabase,
	type TestDb,
} from "../packages/agent-db/src/testing";
import {
	createRedisLiveStreamRelay,
	disabledLiveStreamTelemetry,
	type LiveStreamRelay,
	type LiveStreamRelayOptions,
	type LiveStreamTelemetry,
} from "../packages/live-text/src";

setDefaultTimeout(20_000);

const MEMBER_CODE = "relay-matrix-member";
const IDENTITY_HEADERS = {
	"x-member-code": MEMBER_CODE,
	"x-partner-code": "relay-matrix-partner",
};
const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

type TestApp = ReturnType<
	typeof import("../apps/chat-api/src/app")["createApp"]
>;

let testDatabase: TestDb;
let redis: RedisTestServer;
let createApp: typeof import("../apps/chat-api/src/app")["createApp"];
const openRelays = new Set<LiveStreamRelay>();

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function telemetryProbe(
	operation: Parameters<LiveStreamTelemetry["record"]>[0],
	result: Parameters<LiveStreamTelemetry["record"]>[1],
): {
	telemetry: LiveStreamTelemetry;
	observed: Promise<void>;
} {
	const firstObservation = deferred();
	return {
		telemetry: {
			record(seenOperation, seenResult) {
				if (seenOperation !== operation || seenResult !== result) return;
				firstObservation.resolve();
			},
		},
		observed: firstObservation.promise,
	};
}

function combineTelemetry(
	...telemetry: LiveStreamTelemetry[]
): LiveStreamTelemetry {
	return {
		record(operation, result, options) {
			for (const sink of telemetry) sink.record(operation, result, options);
		},
	};
}

beforeAll(async () => {
	redis = await startRedisTestServer();
	testDatabase = await createTestDatabase();
	({ createApp } = await import("../apps/chat-api/src/app"));
});

afterEach(async () => {
	await Promise.allSettled([...openRelays].map((relay) => relay.close()));
	openRelays.clear();
	await testDatabase.db.delete(runs);
	await testDatabase.db.delete(conversationRuntime);
	await testDatabase.db.delete(conversations);
});

afterAll(async () => {
	await testDatabase.close();
	await redis.stop();
});

function createRelay(
	options: LiveStreamRelayOptions & {
		testClientName?: string;
		url?: string;
	} = {},
): LiveStreamRelay {
	const { url = redis.url, ...relayOptions } = options;
	const relay = createRedisLiveStreamRelay({
		url,
		deployment: "issue-370",
		operationTimeoutMs: 150,
		backlogWaitMs: 50,
		...relayOptions,
	});
	openRelays.add(relay);
	return relay;
}

async function killRedisClientsByNamePrefix(prefix: string): Promise<void> {
	const listing = Bun.spawn(
		[
			"redis-cli",
			"-h",
			"127.0.0.1",
			"-p",
			String(redis.port),
			"CLIENT",
			"LIST",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const output = await new Response(listing.stdout).text();
	if ((await listing.exited) !== 0) {
		throw new Error("failed to list Redis clients for crash injection");
	}
	const clientIds = output
		.split("\n")
		.filter((line) =>
			line
				.split(" ")
				.some(
					(field) =>
						field === `name=${prefix}:publisher` ||
						field === `name=${prefix}:subscriber`,
				),
		)
		.map((line) => line.match(/(?:^| )id=(\d+)(?: |$)/)?.[1])
		.filter((id): id is string => id !== undefined);
	if (clientIds.length < 2) {
		throw new Error("producer Redis connections were not both observable");
	}
	for (const clientId of clientIds) {
		const killing = Bun.spawn(
			[
				"redis-cli",
				"-h",
				"127.0.0.1",
				"-p",
				String(redis.port),
				"CLIENT",
				"KILL",
				"ID",
				clientId,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		if ((await killing.exited) !== 0) {
			throw new Error(`failed to kill producer Redis client ${clientId}`);
		}
	}
}

function buildApp(
	liveStreamRelay: LiveStreamRelay,
	liveStreamTelemetry: LiveStreamTelemetry = disabledLiveStreamTelemetry,
): TestApp {
	const conversationStore = new PostgresConversationStore(testDatabase.db);
	const deps: AppDeps = {
		config: {} as ApiConfig,
		artifactMetadataStore: {
			async listCurrent() {
				return [];
			},
			async getCurrent() {
				return null;
			},
		},
		artifactDownloadSigner: {
			async createDownloadUrl() {
				throw new Error("artifact signing is outside this integration seam");
			},
		},
		conversationStore,
		conversationHistoryStore: new PostgresConversationHistoryStore(
			testDatabase.db,
		),
		runStore: new PostgresRunStore(testDatabase.db),
		liveStreamRelay,
		liveStreamTelemetry,
		closeLiveResources: () => liveStreamRelay.close(),
		exposureGate: {
			async isAgentEnabled() {
				return true;
			},
		},
	};
	return createApp({ logLevel: "silent" } as ApiConfig, deps);
}

function buildLoop(
	processor: RunProcessor,
	liveStreamRelay: LiveStreamRelay,
	workerId = `worker-${crypto.randomUUID()}`,
): { loop: RunLoop; worker: Worker } {
	const worker = new Worker({
		workerId,
		maxConcurrentRuns: 1,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
	return {
		worker,
		loop: new RunLoop({
			db: testDatabase.db,
			worker,
			processor,
			liveStreamRelay,
			heartbeatIntervalMs: 15_000,
			logger: silentLogger,
		}),
	};
}

async function admitRun(message: string): Promise<{
	conversationId: string;
	runId: string;
}> {
	const conversationId = crypto.randomUUID();
	const runId = crypto.randomUUID();
	await new PostgresConversationStore(testDatabase.db).create({
		userId: MEMBER_CODE,
		conversationId,
		scope: "general",
	});
	await new PostgresRunStore(testDatabase.db).admitRun({
		conversation: { userId: MEMBER_CODE, conversationId },
		runId,
		messageId: `user-${runId}`,
		message,
	});
	return { conversationId, runId };
}

function eventsUrl(conversationId: string, runId: string): string {
	return `/v1/conversations/${conversationId}/runs/${runId}/events`;
}

interface SseFrame {
	type: string;
	[key: string]: unknown;
}

function parseSse(body: string): SseFrame[] {
	return parseAgUiSse(body).map(({ data }) => data as SseFrame);
}

async function readRun(runId: string) {
	return testDatabase.db.query.runs.findFirst({
		where: (table, operators) => operators.eq(table.runId, runId),
	});
}

interface HistoryRun {
	runId: string;
	messages: Array<{ id: string; role: string; content: string }>;
	terminalEvent: SseFrame | null;
}

async function readHistory(
	app: TestApp,
	conversationId: string,
): Promise<HistoryRun[]> {
	const response = await app.request(
		`/v1/conversations/${conversationId}/history`,
		{ headers: IDENTITY_HEADERS },
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { runs: HistoryRun[] }).runs;
}

function requiredHistoryRun(history: HistoryRun[], runId: string): HistoryRun {
	const run = history.find((candidate) => candidate.runId === runId);
	if (!run) throw new Error(`Conversation history omitted Run ${runId}`);
	return run;
}

function textResponse(runId: string): { messageId: string; text: string } {
	return {
		messageId: `assistant-${runId}`,
		text: `Durable response for ${runId}`,
	};
}

function expectedTextHistoryMessages(
	runId: string,
	userContent: string,
): Array<{ role: string; content: string }> {
	const response = textResponse(runId);
	return [
		{ role: "user", content: userContent },
		{
			role: "assistant",
			content: response.text,
		},
	];
}

function historyMessageContent(
	run: HistoryRun,
): Array<{ role: string; content: string }> {
	return run.messages.map(({ role, content }) => ({ role, content }));
}

async function expectHistoryRecovery(response: Response): Promise<void> {
	expect(response.status).toBe(410);
	expect(await response.json()).toEqual({
		error: "Live stream unavailable",
		recovery: "history",
	});
}

const completeTextProcessor: RunProcessor = async (ctx) => {
	const { messageId, text } = textResponse(ctx.run.runId);
	await ctx.appendLiveEvent({
		type: "TEXT_MESSAGE_START",
		messageId,
		role: "assistant",
	});
	await ctx.appendLiveEvent({
		type: "TEXT_MESSAGE_CONTENT",
		messageId,
		delta: text,
	});
	await ctx.appendModelContent({
		kind: "assistant_message",
		payload: { messageId, text },
	});
	await ctx.appendLiveEvent({
		type: "TEXT_MESSAGE_END",
		messageId,
	});
};

describe("ADR-0014 relay failure matrix", () => {
	it("streams a queued Run from its first event once the RunLoop claims it", async () => {
		const queuedAttachRetry = telemetryProbe("attach_attempt", "retry");
		const readerAttached = telemetryProbe("attach_attempt", "success");
		const telemetry = combineTelemetry(
			queuedAttachRetry.telemetry,
			readerAttached.telemetry,
		);
		const consumerRelay = createRelay({ telemetry });
		const producerRelay = createRelay();
		const app = buildApp(consumerRelay, telemetry);
		const { conversationId, runId } = await admitRun("queued attach");
		const processorStarted = deferred();
		const continueProcessor = deferred();
		const { loop, worker } = buildLoop(async (ctx) => {
			processorStarted.resolve();
			await continueProcessor.promise;
			await completeTextProcessor(ctx);
		}, producerRelay);

		expect((await readRun(runId))?.status).toBe("queued");
		const responsePromise = app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
		});

		await queuedAttachRetry.observed;
		expect((await readRun(runId))?.status).toBe("queued");
		expect(await loop.tick()).toBe(1);
		await processorStarted.promise;
		await readerAttached.observed;
		continueProcessor.resolve();
		await worker.drain();
		const response = await responsePromise;

		expect(response.status).toBe(200);
		expect(parseSse(await response.text()).map((frame) => frame.type)).toEqual([
			"RUN_STARTED",
			"TEXT_MESSAGE_START",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_END",
			"RUN_FINISHED",
		]);
	});

	it("recovers producer death through stale-Run recovery and Conversation history without fabricating a live Outcome", async () => {
		const readerAttached = telemetryProbe("attach_attempt", "success");
		const consumerRelay = createRelay({ telemetry: readerAttached.telemetry });
		const producerClientName = `issue-370-producer-${crypto.randomUUID()}`;
		const producerRelay = createRelay({
			testClientName: producerClientName,
		});
		const app = buildApp(consumerRelay, readerAttached.telemetry);
		const { conversationId, runId } = await admitRun("producer death");
		const processorStarted = deferred();
		const releaseCrashedProcessor = deferred();
		const crashed = buildLoop(
			async (ctx) => {
				await ctx.appendLiveEvent({
					type: "TEXT_MESSAGE_START",
					messageId: `assistant-${runId}`,
					role: "assistant",
				});
				processorStarted.resolve();
				await releaseCrashedProcessor.promise;
			},
			producerRelay,
			"crashed-worker",
		);

		expect(await crashed.loop.tick()).toBe(1);
		await processorStarted.promise;

		// Intentionally no client timeout: silent producer death must converge
		// through durable recovery, or the test itself must time out and fail.
		const responsePromise = app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
		});
		await readerAttached.observed;
		await killRedisClientsByNamePrefix(producerClientName);
		// This root-level test uses the underlying PGlite client to avoid importing
		// a second Drizzle instance; keep the simulated lease expiry Run-scoped.
		await testDatabase.db.$client.query(
			"update runs set locked_until = $1 where run_id = $2",
			[new Date(0), runId],
		);
		const recovery = buildLoop(
			async () => {},
			createRelay(),
			"recovery-worker",
		);
		expect(await recovery.loop.tick()).toBe(0);

		const response = await responsePromise;
		expect(response.status).toBe(200);
		expect(parseSse(await response.text()).map((frame) => frame.type)).toEqual([
			"RUN_STARTED",
			"TEXT_MESSAGE_START",
		]);
		const reconnect = await app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
		});
		await expectHistoryRecovery(reconnect);
		const historyRun = requiredHistoryRun(
			await readHistory(app, conversationId),
			runId,
		);
		expect(historyRun.terminalEvent?.type).toBe("RUN_ERROR");
		expect(historyMessageContent(historyRun)).toEqual([
			{ role: "user", content: "producer death" },
		]);

		releaseCrashedProcessor.resolve();
		await crashed.worker.drain();
	});

	it("serves history when attach pauses before its backlog request across terminal close", async () => {
		const liveSubscribed = deferred();
		const continueAttach = deferred();
		const consumerRelay = createRelay({
			testHooks: {
				async afterLiveSubscribed() {
					liveSubscribed.resolve();
					await continueAttach.promise;
				},
			},
		});
		const producerRelay = createRelay();
		const app = buildApp(consumerRelay);
		const { conversationId, runId } = await admitRun("terminal attach race");
		const processorStarted = deferred();
		const continueProcessor = deferred();
		const { loop, worker } = buildLoop(async (ctx) => {
			processorStarted.resolve();
			await continueProcessor.promise;
			await completeTextProcessor(ctx);
		}, producerRelay);

		expect(await loop.tick()).toBe(1);
		await processorStarted.promise;
		const responsePromise = app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
			signal: AbortSignal.timeout(3_000),
		});
		await liveSubscribed.promise;
		continueProcessor.resolve();
		await worker.drain();
		continueAttach.resolve();

		const response = await responsePromise;
		await expectHistoryRecovery(response);

		const historyRun = requiredHistoryRun(
			await readHistory(app, conversationId),
			runId,
		);
		expect(historyRun.terminalEvent?.type).toBe("RUN_FINISHED");
	});

	it("streams the live terminal when backlog reply wins the terminal close race", async () => {
		const backlogRequested = deferred();
		const continueBacklogReply = deferred();
		const terminalPublished = deferred();
		const consumerRelay = createRelay();
		const producerRelay = createRelay({
			testHooks: {
				afterEventPublished({ terminal }) {
					if (terminal) terminalPublished.resolve();
				},
				async beforeBacklogReply() {
					backlogRequested.resolve();
					await continueBacklogReply.promise;
				},
			},
		});
		const app = buildApp(consumerRelay);
		const { conversationId, runId } = await admitRun("live terminal race");
		const processorStarted = deferred();
		const continueProcessor = deferred();
		const { loop, worker } = buildLoop(async (ctx) => {
			processorStarted.resolve();
			await continueProcessor.promise;
			await completeTextProcessor(ctx);
		}, producerRelay);

		expect(await loop.tick()).toBe(1);
		await processorStarted.promise;
		const responsePromise = app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
			signal: AbortSignal.timeout(3_000),
		});
		await backlogRequested.promise;
		continueProcessor.resolve();
		await terminalPublished.promise;
		continueBacklogReply.resolve();
		await worker.drain();

		const response = await responsePromise;
		expect(response.status).toBe(200);
		expect(parseSse(await response.text()).map((frame) => frame.type)).toEqual([
			"RUN_STARTED",
			"TEXT_MESSAGE_START",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_END",
			"RUN_FINISHED",
		]);
	});

	it("degrades only live delivery when the real producer buffer cap overflows", async () => {
		const readerAttached = telemetryProbe("attach_attempt", "success");
		const consumerRelay = createRelay({ telemetry: readerAttached.telemetry });
		const producerRelay = createRelay({ testLimits: { maxEvents: 2 } });
		const app = buildApp(consumerRelay, readerAttached.telemetry);
		const { conversationId, runId } = await admitRun("buffer cap overflow");
		const processorStarted = deferred();
		const continueProcessor = deferred();
		const { loop, worker } = buildLoop(async (ctx) => {
			processorStarted.resolve();
			await continueProcessor.promise;
			await completeTextProcessor(ctx);
		}, producerRelay);

		const responsePromise = app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
		});
		expect(await loop.tick()).toBe(1);
		await processorStarted.promise;
		await readerAttached.observed;
		continueProcessor.resolve();
		await worker.drain();

		const response = await responsePromise;
		expect(response.status).toBe(200);
		const liveTypes = parseSse(await response.text()).map(
			(frame) => frame.type,
		);
		expect(liveTypes).toEqual(["RUN_STARTED", "TEXT_MESSAGE_START"]);
		expect(await readRun(runId)).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});

		const historyRun = requiredHistoryRun(
			await readHistory(app, conversationId),
			runId,
		);
		expect(historyMessageContent(historyRun)).toEqual(
			expectedTextHistoryMessages(runId, "buffer cap overflow"),
		);
		expect(historyRun.terminalEvent?.type).toBe("RUN_FINISHED");
		const recovery = await app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
		});
		await expectHistoryRecovery(recovery);
	});

	it("executes durably while Redis is unreachable and preserves the 503-to-410 contract", async () => {
		const unreachableUrl = `redis://127.0.0.1:${await findFreePort()}`;
		const consumerRelay = createRelay({ url: unreachableUrl });
		const producerRelay = createRelay({ url: unreachableUrl });
		const app = buildApp(consumerRelay);
		const { conversationId, runId } = await admitRun("Redis unavailable");

		const unavailable = await app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
			signal: AbortSignal.timeout(3_000),
		});
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({
			error: "Live stream temporarily unavailable",
		});

		const { loop, worker } = buildLoop(completeTextProcessor, producerRelay);
		expect(await loop.tick()).toBe(1);
		await worker.drain();
		expect(await readRun(runId)).toMatchObject({
			status: "done",
			liveStreamFailedAt: expect.any(Date),
		});

		const historyRun = requiredHistoryRun(
			await readHistory(app, conversationId),
			runId,
		);
		expect(historyMessageContent(historyRun)).toEqual(
			expectedTextHistoryMessages(runId, "Redis unavailable"),
		);
		expect(historyRun.terminalEvent?.type).toBe("RUN_FINISHED");

		const recovery = await app.request(eventsUrl(conversationId, runId), {
			headers: IDENTITY_HEADERS,
		});
		await expectHistoryRecovery(recovery);
	});
});
