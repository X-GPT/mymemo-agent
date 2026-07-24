import { afterAll, beforeAll, expect, it } from "bun:test";
import { createServer, type Socket } from "node:net";
import {
	type RedisTestServer,
	startRedisTestServer,
} from "@mymemo/test-support/redis-test-server";
import {
	createInMemoryLiveStreamRelay,
	createRedisLiveStreamRelay,
	LiveStreamRelayError,
} from "./index";
import { liveStreamRelayContract } from "./live-stream-relay.contract";

let redis: RedisTestServer;
let redisUrl: string;

beforeAll(async () => {
	redis = await startRedisTestServer();
	redisUrl = redis.url;
});

afterAll(async () => {
	await redis.stop();
});

liveStreamRelayContract("in-memory", {
	async create(options) {
		return createInMemoryLiveStreamRelay(options);
	},
});

let redisDeployment = 0;
liveStreamRelayContract("Redis", {
	async create(options) {
		redisDeployment += 1;
		return createRedisLiveStreamRelay({
			...options,
			url: redisUrl,
			deployment: `test-${redisDeployment}`,
		});
	},
});

it("bounds Redis operations when a peer accepts TCP but never answers", async () => {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("failed to allocate black-hole Redis port");
	}
	const relay = createRedisLiveStreamRelay({
		url: `redis://127.0.0.1:${address.port}`,
		deployment: "timeout-test",
		operationTimeoutMs: 50,
	});

	const startedAt = performance.now();
	await expect(relay.openProducer("run-timeout")).rejects.toBeInstanceOf(
		LiveStreamRelayError,
	);
	expect(performance.now() - startedAt).toBeLessThan(1_000);

	await relay.close();
	for (const socket of sockets) socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
