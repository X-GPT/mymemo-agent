import { afterAll, beforeAll, expect, it } from "bun:test";
import {
	type RedisTestServer,
	startRedisTestServer,
} from "@mymemo/test-support/redis-test-server";
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
	const streams = createAiChatResumableStreams(redis.url);
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
	const resumed = await streams.resume("stream-1");
	if (!resumed) throw new Error("expected resumable stream");
	const reader = resumed.getReader();
	expect(await reader.read()).toEqual({ done: false, value: "first" });
	release.resolve();
	expect(await reader.read()).toEqual({ done: false, value: "second" });
	expect(await reader.read()).toEqual({ done: true, value: undefined });
	expect(await streams.resume("stream-1")).toBeNull();
	expect(await streams.resume("missing-stream")).toBeUndefined();
	streams.close();
});

it("treats a dead producer's surviving sentinel as an absent stream", async () => {
	if (!redis) throw new Error("Redis test server did not start");
	const producer = createAiChatResumableStreams(redis.url);
	await producer.create("dead-stream", new ReadableStream<string>());
	producer.close();

	const consumer = createAiChatResumableStreams(redis.url);
	expect(await consumer.resume("dead-stream")).toBeUndefined();
	consumer.close();
});
