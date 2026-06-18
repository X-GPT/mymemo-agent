import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { SyncLogger } from "./sandbox-provider";

const silentLogger: SyncLogger = { info: () => {}, error: () => {} };

describe("LocalContainerSandboxProvider", () => {
	let LocalContainerSandboxProvider: typeof import("./local-container-sandbox-provider").LocalContainerSandboxProvider;
	let apiEnv: typeof import("@/config/env").apiEnv;
	let fetchSpy: ReturnType<typeof spyOn> | undefined;

	beforeAll(async () => {
		// apiEnv is a cached singleton shared across the whole suite, so use the
		// SAME values the other orchestration test sets (any first importer wins)
		// and assert against apiEnv.* rather than literals to stay order-independent.
		Bun.env.E2B_API_KEY = "test-e2b-key";
		Bun.env.DAEMON_AUTH_TOKEN = "test-daemon-auth-token";
		Bun.env.LLM_TOKEN_SECRET = "test-llm-token-secret";
		Bun.env.GATEWAY_PUBLIC_URL = "https://gateway.test";
		Bun.env.LOCAL_SANDBOX_DAEMON_URL = "http://sandbox:8080";
		({ LocalContainerSandboxProvider } = await import(
			"./local-container-sandbox-provider"
		));
		({ apiEnv } = await import("@/config/env"));
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		fetchSpy = undefined;
	});

	it("createSandbox returns a static handle without touching the network", async () => {
		const provider = new LocalContainerSandboxProvider();
		const handle = await provider.createSandbox("user-1", silentLogger);
		expect(handle).toEqual({ sandboxId: "local-sandbox" });
	});

	it("ensureSandboxDaemon returns the daemon endpoint once /health is ok", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 200 }),
		);
		const provider = new LocalContainerSandboxProvider();

		const endpoint = await provider.ensureSandboxDaemon(
			"user-1",
			{ sandboxId: "local-sandbox" },
			silentLogger,
		);

		expect(endpoint).toEqual({
			url: apiEnv.LOCAL_SANDBOX_DAEMON_URL,
			authToken: apiEnv.DAEMON_AUTH_TOKEN,
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			`${apiEnv.LOCAL_SANDBOX_DAEMON_URL}/health`,
			expect.anything(),
		);
	});

	it("ensureSandboxDaemon keeps polling past transient fetch rejections, then succeeds", async () => {
		let calls = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls += 1;
			// First couple of polls: daemon not accepting connections yet.
			if (calls < 3) throw new Error("ECONNREFUSED");
			return new Response(null, { status: 200 });
		});
		const provider = new LocalContainerSandboxProvider({
			readyTimeoutMs: 1_000,
			pollIntervalMs: 5,
		});

		const endpoint = await provider.ensureSandboxDaemon(
			"user-1",
			{ sandboxId: "local-sandbox" },
			silentLogger,
		);

		expect(endpoint.url).toBe(apiEnv.LOCAL_SANDBOX_DAEMON_URL);
		expect(calls).toBeGreaterThanOrEqual(3);
	});

	it("ensureSandboxDaemon throws if the daemon never becomes healthy", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 503 }),
		);
		const provider = new LocalContainerSandboxProvider({
			readyTimeoutMs: 40,
			pollIntervalMs: 5,
		});

		await expect(
			provider.ensureSandboxDaemon(
				"user-1",
				{ sandboxId: "local-sandbox" },
				silentLogger,
			),
		).rejects.toThrow(/did not become healthy/);
	});

	it("killSandbox is a no-op (the local container outlives the turn)", async () => {
		const provider = new LocalContainerSandboxProvider();
		await expect(provider.killSandbox()).resolves.toBeUndefined();
	});
});
