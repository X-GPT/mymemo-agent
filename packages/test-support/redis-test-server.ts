import { createServer } from "node:net";

export interface RedisTestServer {
	port: number;
	url: string;
	stop(): Promise<void>;
}

interface RedisTestServerOptions {
	password?: string;
	port?: number;
	stdio?: "ignore" | "inherit";
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
	const process = Bun.spawn(serverArguments, {
		stdout: stdio,
		stderr: stdio,
	});
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const pingArguments = ["redis-cli", "-h", "127.0.0.1", "-p", String(port)];
		if (options.password) pingArguments.push("-a", options.password);
		pingArguments.push("ping");
		const ping = Bun.spawn(pingArguments, {
			stdout: "ignore",
			stderr: "ignore",
		});
		if ((await ping.exited) === 0) {
			let stopped = false;
			const authority = options.password
				? `:${encodeURIComponent(options.password)}@127.0.0.1`
				: "127.0.0.1";
			return {
				port,
				url: `redis://${authority}:${port}`,
				async stop() {
					if (stopped) return;
					stopped = true;
					process.kill("SIGTERM");
					await process.exited;
				},
			};
		}
		await Bun.sleep(50);
	}
	process.kill("SIGTERM");
	await process.exited;
	throw new Error("Redis did not become ready");
}
