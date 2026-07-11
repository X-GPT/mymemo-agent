import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { createClient } from "redis";
import {
	createRedisLiveTextTransport,
	InMemoryLiveTextTransport,
	LIVE_TEXT_MAX_WIRE_BYTES,
	type LiveTextPublisher,
	type LiveTextSubscriber,
	type LiveTextTransport,
	liveTextChannel,
} from "./index";

interface ContractHarness {
	publisher: LiveTextPublisher;
	subscriber: LiveTextSubscriber;
	close(): Promise<void>;
	disconnect(): Promise<void>;
	reconnect(): Promise<void>;
}

type ContractHarnessFactory = () => Promise<ContractHarness>;

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

async function collectMessages(
	subscription: Awaited<ReturnType<LiveTextSubscriber["subscribe"]>>,
	count: number,
): Promise<string[]> {
	const texts: string[] = [];
	await waitUntil(async () => {
		await subscription.waitForMessage({ timeoutMs: 100 });
		texts.push(...subscription.readAvailable().map((message) => message.text));
		return texts.length >= count;
	});
	return texts;
}

function liveTextTransportContract(
	name: string,
	createHarness: ContractHarnessFactory,
): void {
	describe(name, () => {
		it("isolates Runs, preserves publisher order, and fans out to subscribers", async () => {
			const harness = await createHarness();
			const runOneA = await harness.subscriber.subscribe("run-1");
			const runOneB = await harness.subscriber.subscribe("run-1");
			const runTwo = await harness.subscriber.subscribe("run-2");
			try {
				for (const [deltaIndex, text] of ["one", "two", "three"].entries()) {
					await harness.publisher.publish({
						runId: "run-1",
						messageId: "message-1",
						deltaIndex,
						text,
					});
				}
				const expected = ["one", "two", "three"];
				expect(await collectMessages(runOneA, 3)).toEqual(expected);
				expect(await collectMessages(runOneB, 3)).toEqual(expected);
				expect(runTwo.readAvailable()).toEqual([]);
			} finally {
				await Promise.all([runOneA.close(), runOneB.close(), runTwo.close()]);
				await harness.close();
			}
		});

		it("unsubscribes independently and releases pending work on cleanup", async () => {
			const harness = await createHarness();
			const closed = await harness.subscriber.subscribe("run-1");
			const active = await harness.subscriber.subscribe("run-1");
			const waiting = closed.waitForMessage();
			await closed.close();
			expect(await waiting).toBe(false);

			await harness.publisher.publish({
				runId: "run-1",
				messageId: "message-1",
				deltaIndex: 0,
				text: "only active receives this",
			});
			await active.waitForMessage({ timeoutMs: 1_000 });
			expect(closed.readAvailable()).toEqual([]);
			expect(active.readAvailable()).toHaveLength(1);

			const activeWait = active.waitForMessage();
			await harness.close();
			expect(await activeWait).toBe(false);
			await expect(harness.subscriber.subscribe("run-2")).rejects.toThrow();
		});

		it("recovers an established lane after a connection outage", async () => {
			const harness = await createHarness();
			const subscription = await harness.subscriber.subscribe("run-1");
			try {
				await harness.publisher.publish({
					runId: "run-1",
					messageId: "before",
					deltaIndex: 0,
					text: "before",
				});
				await subscription.waitForMessage({ timeoutMs: 1_000 });
				expect(subscription.readAvailable()).toHaveLength(1);

				await harness.disconnect();
				await harness.reconnect();
				await waitUntil(async () => {
					try {
						await harness.publisher.publish({
							runId: "run-1",
							messageId: "after",
							deltaIndex: 0,
							text: "after",
						});
						await subscription.waitForMessage({ timeoutMs: 100 });
						return subscription
							.readAvailable()
							.some((message) => message.text === "after");
					} catch {
						return false;
					}
				}, 5_000);
			} finally {
				await subscription.close();
				await harness.close();
			}
		}, 10_000);
	});
}

liveTextTransportContract("in-memory Live transport contract", async () => {
	const transport: LiveTextTransport = new InMemoryLiveTextTransport();
	let connected = true;
	return {
		publisher: {
			publish(message, options) {
				if (!connected) return Promise.reject(new Error("disconnected"));
				return transport.publish(message, options);
			},
		},
		subscriber: transport,
		close: () => transport.close(),
		disconnect: async () => {
			connected = false;
		},
		reconnect: async () => {
			connected = true;
		},
	};
});

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

async function stopRedis(process: RedisProcess): Promise<void> {
	process.kill("SIGTERM");
	await process.exited;
}

liveTextTransportContract(
	"disposable Redis Live transport contract",
	async () => {
		const port = await freePort();
		let server = await startRedis(port);
		const transport = createRedisLiveTextTransport({
			url: `redis://127.0.0.1:${port}`,
			operationTimeoutMs: 250,
			reconnectMaxDelayMs: 100,
		});
		return {
			publisher: transport,
			subscriber: transport,
			close: async () => {
				await transport.close();
				if (server.exitCode === null) await stopRedis(server);
			},
			disconnect: async () => {
				await stopRedis(server);
			},
			reconnect: async () => {
				server = await startRedis(port);
			},
		};
	},
);

it("drops invalid and oversized Redis messages with payload-free signals", async () => {
	const port = await freePort();
	const server = await startRedis(port);
	const url = `redis://127.0.0.1:${port}`;
	const signals: string[] = [];
	const transport = createRedisLiveTextTransport({
		url,
		onSignal: (signal) => signals.push(signal),
	});
	const rawPublisher = createClient({ url });
	try {
		const subscription = await transport.subscribe("run-1");
		await rawPublisher.connect();
		await rawPublisher.publish(liveTextChannel("run-1"), "not json");
		await subscription.waitForMessage({ timeoutMs: 1_000 });
		expect(subscription.readAvailable()).toEqual([]);
		expect(subscription.readDroppedMessages()).toEqual({
			type: "invalid_wire_message",
		});

		await rawPublisher.publish(
			liveTextChannel("run-1"),
			"x".repeat(LIVE_TEXT_MAX_WIRE_BYTES + 1),
		);
		await subscription.waitForMessage({ timeoutMs: 1_000 });
		expect(subscription.readAvailable()).toEqual([]);
		expect(subscription.readDroppedMessages()).toEqual({
			type: "invalid_wire_message",
		});
		expect(signals).toEqual(["invalid_message", "oversized_message"]);
		await subscription.close();
	} finally {
		if (rawPublisher.isOpen) rawPublisher.destroy();
		await transport.close();
		await stopRedis(server);
	}
}, 10_000);
