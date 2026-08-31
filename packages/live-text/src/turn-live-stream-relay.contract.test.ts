import { afterAll, beforeAll } from "bun:test";
import {
	type RedisTestServer,
	startRedisTestServer,
} from "@mymemo/test-support/redis-test-server";
import {
	createInMemoryTurnLiveStreamRelay,
	createRedisTurnLiveStreamRelay,
} from "./index";
import { turnLiveStreamRelayContract } from "./turn-live-stream-relay.contract";

let redis: RedisTestServer;
let redisUrl: string;

beforeAll(async () => {
	redis = await startRedisTestServer();
	redisUrl = redis.url;
});

afterAll(async () => {
	await redis.stop();
});

turnLiveStreamRelayContract("in-memory", {
	create: createInMemoryTurnLiveStreamRelay,
});

let redisDeployment = 0;
turnLiveStreamRelayContract("Redis", {
	create(options) {
		redisDeployment += 1;
		return createRedisTurnLiveStreamRelay({
			...options,
			url: redisUrl,
			deployment: `test-${redisDeployment}`,
		});
	},
});
