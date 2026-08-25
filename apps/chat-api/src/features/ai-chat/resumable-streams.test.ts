import { afterAll, beforeAll, expect, it } from "bun:test";
import {
	type RedisTestServer,
	startRedisTestServer,
} from "@mymemo/test-support/redis-test-server";
import { createClient } from "redis";
import { createResumableStreamContext } from "resumable-stream";
import { createAiChatResumableStreams } from "./resumable-streams";

let redis: RedisTestServer | undefined;

beforeAll(async () => {
	redis = await startRedisTestServer();
});

afterAll(async () => {
	await redis?.stop();
});

it("creates, discovers, appends, resumes, and completes a Redis-backed stream", async () => {
	if (!redis) throw new Error("Redis test server did not start");
	const publisher = createClient({
		url: redis.url,
		socket: { reconnectStrategy: false },
	});
	const subscriber = createClient({
		url: redis.url,
		socket: { reconnectStrategy: false },
	});
	publisher.on("error", () => {});
	subscriber.on("error", () => {});
	await Promise.all([publisher.connect(), subscriber.connect()]);
	const context = createResumableStreamContext({
		keyPrefix: `test:${crypto.randomUUID()}`,
		waitUntil: null,
		publisher,
		subscriber,
	});
	const streams = createAiChatResumableStreams(() => context);
	const release = Promise.withResolvers<void>();
	const source = new ReadableStream<string>({
		start(controller) {
			controller.enqueue("first");
			void release.promise.then(() => {
				controller.enqueue("second");
				controller.close();
			});
		},
	});

	await streams.create("stream-1", source);
	expect(await context.hasExistingStream("stream-1")).toBe(true);
	const resumed = await streams.resume("stream-1");
	if (!resumed) throw new Error("expected resumable stream");
	const reader = resumed.getReader();
	expect(await reader.read()).toEqual({ done: false, value: "first" });
	release.resolve();
	expect(await reader.read()).toEqual({ done: false, value: "second" });
	expect(await reader.read()).toEqual({ done: true, value: undefined });
	expect(await context.hasExistingStream("stream-1")).toBe("DONE");
	expect(await streams.resume("stream-1")).toBeNull();
	expect(await streams.resume("missing-stream")).toBeUndefined();

	publisher.destroy();
	subscriber.destroy();
});

it("recreates its context after an operation failure", async () => {
	let attempts = 0;
	const streams = createAiChatResumableStreams(
		() =>
			({
				async createNewResumableStream() {
					attempts++;
					if (attempts === 1) throw new Error("Redis unavailable");
					return new ReadableStream<string>();
				},
			}) as unknown as ReturnType<typeof createResumableStreamContext>,
	);
	const source = new ReadableStream<string>();

	await expect(streams.create("stream-1", source)).rejects.toThrow(
		"Redis unavailable",
	);
	await expect(streams.create("stream-1", source)).resolves.toBeUndefined();
	expect(attempts).toBe(2);
});
