import { expect, it } from "bun:test";
import { createServer } from "node:net";
import {
	EventSchemas,
	EventType,
	type TextMessageContentEvent,
} from "@ag-ui/core";
import type { ResumableStreamEntry } from "assistant-stream/resumable";
import { createClient } from "redis";
import {
	createRedisLiveStreamStore,
	encodeAgUiLiveStreamEvent,
	LIVE_STREAM_MAX_BYTES,
	LIVE_STREAM_MAX_EVENT_BYTES,
	LIVE_STREAM_MAX_EVENTS,
	LIVE_STREAM_RETENTION_MS,
	LIVE_STREAM_TEXT_EVENT_TARGET_BYTES,
	type LiveStreamStore,
} from "./index";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function startRedis(
	port: number,
	password?: string,
): Promise<RedisProcess> {
	const serverArguments = [
		"redis-server",
		"--bind",
		"127.0.0.1",
		"--port",
		String(port),
		"--save",
		"",
		"--appendonly",
		"no",
	];
	if (password) serverArguments.push("--requirepass", password);
	const process = Bun.spawn(serverArguments, {
		stdout: "ignore",
		stderr: "ignore",
	});
	await waitUntil(async () => {
		const pingArguments = ["redis-cli", "-h", "127.0.0.1", "-p", String(port)];
		if (password) pingArguments.push("-a", password);
		pingArguments.push("ping");
		const ping = Bun.spawn(pingArguments, { stdout: "pipe", stderr: "ignore" });
		return (await ping.exited) === 0;
	});
	return process;
}

async function stopRedis(process: RedisProcess): Promise<void> {
	process.kill("SIGTERM");
	await process.exited;
}

async function collect(
	store: LiveStreamStore,
	streamId: string,
	cursor = "",
): Promise<ResumableStreamEntry[]> {
	const entries: ResumableStreamEntry[] = [];
	for await (const entry of store.read(
		streamId,
		cursor,
		new AbortController().signal,
	)) {
		entries.push(entry);
	}
	return entries;
}

it("elects exactly one producer when workers race for a Run", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const stores = Array.from({ length: 8 }, () =>
		createRedisLiveStreamStore({
			url: `redis://127.0.0.1:${port}`,
			deployment: "test",
		}),
	);
	const event = encoder.encode(
		JSON.stringify({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "producer only",
		}),
	);
	try {
		const roles = await Promise.all(
			stores.map((store) => store.acquire("run-1")),
		);
		expect(roles.filter((role) => role === "producer")).toHaveLength(1);
		expect(roles.filter((role) => role === "consumer")).toHaveLength(7);
		const consumerIndex = roles.indexOf("consumer");
		const consumer = stores[consumerIndex];
		if (!consumer) throw new Error("expected a consumer store");
		await expect(consumer.append("run-1", event)).rejects.toMatchObject({
			code: "not_producer",
		});
	} finally {
		await Promise.all(stores.map((store) => store.close()));
		await stopRedis(redis);
	}
}, 10_000);

it("replays complete AG-UI events from zero and strictly after a Redis cursor", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
	});
	const events: TextMessageContentEvent[] = [
		{
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "hello ",
		},
		{
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "world",
		},
	];
	try {
		expect(await store.acquire("run-1")).toBe("producer");
		for (const event of events) {
			await store.append("run-1", encoder.encode(JSON.stringify(event)));
		}
		await store.finalize("run-1", "done");
		await store.finalize("run-1", "done");

		const replay = await collect(store, "run-1");
		expect(
			replay.map(({ chunk }) => JSON.parse(decoder.decode(chunk))),
		).toEqual(events);
		expect(replay.map(({ cursor }) => cursor)).toEqual([
			expect.stringMatching(/^\d+-\d+$/),
			expect.stringMatching(/^\d+-\d+$/),
		]);
		const [first, second] = replay;
		if (!first || !second) throw new Error("expected two replay entries");
		expect(await collect(store, "run-1", first.cursor)).toEqual([second]);
		expect(await store.status("run-1")).toBe("done");
	} finally {
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("rejects a Redis-shaped cursor that the retained Stream never issued", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
	});
	try {
		await store.acquire("run-1");
		await store.append(
			"run-1",
			encoder.encode(
				JSON.stringify({
					type: EventType.RUN_FINISHED,
					threadId: "conversation-1",
					runId: "run-1",
				}),
			),
		);
		await store.finalize("run-1", "done");

		await expect(
			collect(store, "run-1", "9999999999999-0"),
		).rejects.toMatchObject({ code: "invalid_cursor" });
	} finally {
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("rejects a cursor before an active Stream has issued its first entry", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
	});
	try {
		await store.acquire("run-1");
		await expect(collect(store, "run-1", "1-0")).rejects.toMatchObject({
			code: "invalid_cursor",
		});
	} finally {
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("reports a missing Stream when its metadata outlives the retained entries", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const url = `redis://127.0.0.1:${port}`;
	const rawRedis = createClient({ url });
	const store = createRedisLiveStreamStore({
		url,
		deployment: "test",
	});
	try {
		await rawRedis.connect();
		await store.acquire("run-1");
		await store.append(
			"run-1",
			encoder.encode(
				JSON.stringify({
					type: EventType.RUN_FINISHED,
					threadId: "conversation-1",
					runId: "run-1",
				}),
			),
		);
		await store.finalize("run-1", "done");
		const [terminal] = await collect(store, "run-1");
		if (!terminal) throw new Error("expected a terminal entry");

		await rawRedis.del("test:mymemo:agui:{run-1}:stream");
		expect(await store.status("run-1")).toBe("done");
		await expect(
			collect(store, "run-1", terminal.cursor),
		).rejects.toMatchObject({
			code: "missing",
		});
	} finally {
		if (rawRedis.isOpen) rawRedis.destroy();
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("does not lose the terminal event when append and finalization race a reader", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
	});
	const terminalEvent = {
		type: EventType.RUN_FINISHED,
		threadId: "conversation-1",
		runId: "run-1",
	};
	try {
		await store.acquire("run-1");
		const replayPromise = collect(store, "run-1");
		await Bun.sleep(20);
		await store.append("run-1", encoder.encode(JSON.stringify(terminalEvent)));
		await store.finalize("run-1", "done");

		const replay = await replayPromise;
		expect(replay).toHaveLength(1);
		expect(JSON.parse(decoder.decode(replay[0]?.chunk))).toEqual(terminalEvent);
	} finally {
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("terminates an active reader when its Stream is deleted", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
	});
	try {
		await store.acquire("run-1");
		const replayPromise = collect(store, "run-1");
		await Bun.sleep(20);
		await store.delete("run-1");
		expect(await replayPromise).toEqual([]);
	} finally {
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("deduplicates a sequential append retry without weakening finalization", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
	});
	const firstEvent = encoder.encode(
		JSON.stringify({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "first",
		}),
	);
	const secondEvent = encoder.encode(
		JSON.stringify({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "second",
		}),
	);
	try {
		await store.acquire("run-1");
		const first = await store.appendWithRetryId(
			"run-1",
			"append-1",
			firstEvent,
		);
		expect(
			await store.appendWithRetryId("run-1", "append-1", firstEvent),
		).toEqual({ cursor: first.cursor, appended: false });
		await expect(
			store.appendWithRetryId("run-1", "append-1", secondEvent),
		).rejects.toMatchObject({ code: "append_retry_conflict" });
		await store.appendWithRetryId("run-1", "append-2", secondEvent);

		await store.finalize("run-1", "done");
		await store.finalize("run-1", "done");
		await expect(
			store.finalize("run-1", "error", "different"),
		).rejects.toMatchObject({ code: "finalize_conflict" });
		expect(await collect(store, "run-1")).toHaveLength(2);
	} finally {
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("rejects event, byte, and entry cap crossings without trimming", async () => {
	expect(LIVE_STREAM_MAX_EVENT_BYTES).toBe(32 * 1_024);
	expect(LIVE_STREAM_MAX_BYTES).toBe(8 * 1_024 * 1_024);
	expect(LIVE_STREAM_MAX_EVENTS).toBe(10_000);
	const port = await freePort();
	const redis = await startRedis(port);
	const url = `redis://127.0.0.1:${port}`;
	const event = encoder.encode(
		JSON.stringify({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "bounded",
		}),
	);
	const oversized = encoder.encode(
		JSON.stringify({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "x".repeat(200),
		}),
	);
	const stores: LiveStreamStore[] = [];
	try {
		const hardBound = createRedisLiveStreamStore({
			url,
			deployment: "hard-bound",
		});
		stores.push(hardBound);
		await hardBound.acquire("run-1");
		const overHardBound = encoder.encode(
			JSON.stringify({
				type: EventType.CUSTOM,
				name: "large",
				value: "x".repeat(LIVE_STREAM_MAX_EVENT_BYTES),
			}),
		);
		await expect(
			hardBound.append("run-1", overHardBound),
		).rejects.toMatchObject({ code: "event_too_large" });

		const eventBound = createRedisLiveStreamStore({
			url,
			deployment: "event-bound",
			testLimits: { maxEventBytes: event.byteLength },
		});
		stores.push(eventBound);
		await eventBound.acquire("run-1");
		await expect(eventBound.append("run-1", oversized)).rejects.toMatchObject({
			code: "event_too_large",
		});
		await eventBound.append("run-1", event);
		await eventBound.finalize("run-1", "done");
		expect(await collect(eventBound, "run-1")).toHaveLength(1);

		const byteBound = createRedisLiveStreamStore({
			url,
			deployment: "byte-bound",
			testLimits: { maxStreamBytes: event.byteLength * 2 },
		});
		stores.push(byteBound);
		await byteBound.acquire("run-1");
		await byteBound.append("run-1", event);
		await byteBound.append("run-1", event);
		await expect(byteBound.append("run-1", event)).rejects.toMatchObject({
			code: "stream_bytes_exceeded",
		});
		await byteBound.finalize("run-1", "done");
		expect(await collect(byteBound, "run-1")).toHaveLength(2);

		const eventCountBound = createRedisLiveStreamStore({
			url,
			deployment: "count-bound",
			testLimits: { maxEvents: 2 },
		});
		stores.push(eventCountBound);
		await eventCountBound.acquire("run-1");
		await eventCountBound.append("run-1", event);
		await eventCountBound.append("run-1", event);
		await expect(eventCountBound.append("run-1", event)).rejects.toMatchObject({
			code: "stream_events_exceeded",
		});
		await eventCountBound.finalize("run-1", "done");
		expect(await collect(eventCountBound, "run-1")).toHaveLength(2);
	} finally {
		await Promise.all(stores.map((store) => store.close()));
		await stopRedis(redis);
	}
}, 10_000);

it("splits large Unicode text deltas into complete standard AG-UI events", () => {
	const delta = "😀漢字é".repeat(5_000);
	const encoded = encodeAgUiLiveStreamEvent({
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: "message-1",
		delta,
	});

	expect(encoded.length).toBeGreaterThan(1);
	const events = encoded.map((bytes) => {
		expect(bytes.byteLength).toBeLessThanOrEqual(
			LIVE_STREAM_TEXT_EVENT_TARGET_BYTES,
		);
		return EventSchemas.parse(JSON.parse(decoder.decode(bytes)));
	});
	const textEvents = events.map((event) => {
		expect(event.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
		if (event.type !== EventType.TEXT_MESSAGE_CONTENT) {
			throw new Error("expected text content event");
		}
		const first = event.delta.charCodeAt(0);
		const last = event.delta.charCodeAt(event.delta.length - 1);
		expect(first < 0xdc00 || first > 0xdfff).toBe(true);
		expect(last < 0xd800 || last > 0xdbff).toBe(true);
		return event;
	});
	expect(textEvents.map((event) => event.delta).join("")).toBe(delta);
});

it("rejects bytes that are not exactly one standard AG-UI event", async () => {
	const port = await freePort();
	const redis = await startRedis(port);
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
	});
	try {
		await store.acquire("run-1");
		await expect(
			store.append("run-1", encoder.encode('{"type":"UNKNOWN"}')),
		).rejects.toMatchObject({ code: "invalid_event" });
		await expect(
			store.append(
				"run-1",
				encoder.encode(
					'{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"ok"}\n{}',
				),
			),
		).rejects.toMatchObject({ code: "invalid_event" });
		await store.finalize("run-1", "done");
		expect(await collect(store, "run-1")).toEqual([]);
	} finally {
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("refreshes an active Stream and expires both keys after terminal grace", async () => {
	expect(LIVE_STREAM_RETENTION_MS).toBe(30 * 60 * 1_000);
	const port = await freePort();
	const redis = await startRedis(port);
	const rawRedis = createClient({ url: `redis://127.0.0.1:${port}` });
	const store = createRedisLiveStreamStore({
		url: `redis://127.0.0.1:${port}`,
		deployment: "test",
		testLimits: { retentionMs: 500 },
	});
	const event = encoder.encode(
		JSON.stringify({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: "kept alive",
		}),
	);
	try {
		await rawRedis.connect();
		await expect(store.acquire("short-run", { ttlMs: 250 })).rejects.toThrow(
			"ttlMs is fixed by the Live Stream retention policy",
		);
		await store.acquire("run-1");
		await store.append("run-1", event);
		await Bun.sleep(300);
		expect(await store.refresh("run-1")).toBe(true);
		await Bun.sleep(300);
		await store.append("run-1", event);
		await store.finalize("run-1", "done");
		expect(await collect(store, "run-1")).toHaveLength(2);

		await Bun.sleep(300);
		expect(await store.status("run-1")).toBe("done");
		await Bun.sleep(250);
		expect(await store.status("run-1")).toBe("missing");
		await expect(collect(store, "run-1")).rejects.toMatchObject({
			code: "missing",
		});
		expect(await rawRedis.exists("test:mymemo:agui:{run-1}:meta")).toBe(0);
		expect(await rawRedis.exists("test:mymemo:agui:{run-1}:stream")).toBe(0);
	} finally {
		if (rawRedis.isOpen) rawRedis.destroy();
		await store.close();
		await stopRedis(redis);
	}
}, 10_000);

it("fails closed on unavailable Redis without exposing credentials or content", async () => {
	const port = await freePort();
	const credential = "store-secret";
	const content = "private assistant output";
	const redis = await startRedis(port, credential);
	let redisRunning = true;
	const store = createRedisLiveStreamStore({
		url: `redis://default:${credential}@127.0.0.1:${port}`,
		deployment: "test",
	});
	const event = encoder.encode(
		JSON.stringify({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "message-1",
			delta: content,
		}),
	);
	const consoleMessages: unknown[][] = [];
	const captureConsole = (...arguments_: unknown[]) => {
		consoleMessages.push(arguments_);
	};
	const originalConsole = {
		log: console.log,
		warn: console.warn,
		error: console.error,
	};
	try {
		await store.acquire("run-1");
		console.log = captureConsole;
		console.warn = captureConsole;
		console.error = captureConsole;
		await stopRedis(redis);
		redisRunning = false;

		let unavailable: unknown;
		try {
			await store.appendWithRetryId("run-1", "append-1", event);
		} catch (error) {
			unavailable = error;
		}
		expect(unavailable).toBeInstanceOf(Error);
		const message = String(unavailable);
		expect(message).not.toContain(credential);
		expect(message).not.toContain(content);
		const logged = JSON.stringify(consoleMessages);
		expect(logged).not.toContain(credential);
		expect(logged).not.toContain(content);
	} finally {
		console.log = originalConsole.log;
		console.warn = originalConsole.warn;
		console.error = originalConsole.error;
		await store.close();
		if (redisRunning) await stopRedis(redis);
	}
}, 10_000);
