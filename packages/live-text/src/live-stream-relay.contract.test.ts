import { afterAll, beforeAll } from "bun:test";
import { createServer } from "node:net";
import {
	createInMemoryLiveStreamRelay,
	createRedisLiveStreamRelay,
} from "./index";
import { liveStreamRelayContract } from "./live-stream-relay.contract";

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
			{ stdout: "pipe", stderr: "ignore" },
		);
		return (await ping.exited) === 0;
	});
	return process;
}

let redisProcess: RedisProcess;
let redisUrl: string;

beforeAll(async () => {
	const port = await freePort();
	redisUrl = `redis://127.0.0.1:${port}`;
	redisProcess = await startRedis(port);
});

afterAll(async () => {
	redisProcess.kill("SIGTERM");
	await redisProcess.exited;
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
