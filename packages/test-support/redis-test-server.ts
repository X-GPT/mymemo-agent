import { createServer } from "node:net";
import { createClient } from "redis";

export interface RedisTestServer {
	port: number;
	url: string;
	command(arguments_: readonly string[]): Promise<unknown>;
	stop(): Promise<void>;
}

interface RedisTestServerOptions {
	password?: string;
	port?: number;
	stdio?: "ignore" | "inherit";
}

async function runRedisCommand(
	url: string,
	arguments_: readonly string[],
): Promise<unknown> {
	const client = createClient({
		url,
		socket: {
			connectTimeout: 500,
			reconnectStrategy: false,
		},
	});
	client.on("error", () => {});
	try {
		await client.connect();
		return await client.sendCommand(arguments_);
	} finally {
		if (client.isOpen) {
			await client.close();
		} else {
			client.destroy();
		}
	}
}

async function waitForRedis(url: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			if ((await runRedisCommand(url, ["PING"])) === "PONG") return;
		} catch {
			// A newly spawned local process may not be accepting connections yet.
		}
		await Bun.sleep(50);
	}
	throw new Error("Redis did not become ready");
}

export async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate test fixture port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

export async function startRedisTestServer(
	options: RedisTestServerOptions = {},
): Promise<RedisTestServer> {
	const configuredUrl =
		options.password === undefined && options.port === undefined
			? process.env.TEST_REDIS_URL?.trim()
			: undefined;
	if (configuredUrl) {
		const parsed = new URL(configuredUrl);
		const port = Number(parsed.port || 6379);
		await waitForRedis(configuredUrl);
		await runRedisCommand(configuredUrl, ["FLUSHDB"]);
		let stopped = false;
		return {
			port,
			url: configuredUrl,
			command: (arguments_) => runRedisCommand(configuredUrl, arguments_),
			async stop() {
				if (stopped) return;
				stopped = true;
				await runRedisCommand(configuredUrl, ["FLUSHDB"]);
			},
		};
	}

	const port = options.port ?? (await findFreePort());
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
	if (options.password) {
		serverArguments.push("--requirepass", options.password);
	}
	const stdio = options.stdio ?? "ignore";
	const serverProcess = Bun.spawn(serverArguments, {
		stdout: stdio,
		stderr: stdio,
	});
	const authority = options.password
		? `:${encodeURIComponent(options.password)}@127.0.0.1`
		: "127.0.0.1";
	const url = `redis://${authority}:${port}`;
	try {
		await waitForRedis(url);
	} catch (error) {
		serverProcess.kill("SIGTERM");
		await serverProcess.exited;
		throw error;
	}
	let stopped = false;
	return {
		port,
		url,
		command: (arguments_) => runRedisCommand(url, arguments_),
		async stop() {
			if (stopped) return;
			stopped = true;
			serverProcess.kill("SIGTERM");
			await serverProcess.exited;
		},
	};
}
