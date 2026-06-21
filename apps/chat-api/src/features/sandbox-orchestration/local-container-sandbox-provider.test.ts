import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ApiConfig } from "@/config/env";
import { LocalContainerSandboxProvider } from "./local-container-sandbox-provider";
import type { SyncLogger } from "./sandbox-provider";

const silentLogger: SyncLogger = { info: () => {}, error: () => {} };

// Config is injected directly — no env juggling, the point of the DI refactor.
const config: ApiConfig = {
	sandboxProvider: "local",
	localSandboxDaemonUrl: "http://sandbox:8080",
	e2bTemplate: "unused",
	llmTokenSecret: "test-llm-secret",
	gatewayPublicUrl: "http://gateway:8080",
	logLevel: "info",
	workspaceStoreRoot: "/tmp/unused",
};

describe("LocalContainerSandboxProvider", () => {
	let fetchSpy: ReturnType<typeof spyOn> | undefined;

	afterEach(() => {
		fetchSpy?.mockRestore();
		fetchSpy = undefined;
	});

	it("createSandbox returns a static handle without touching the network", async () => {
		const provider = new LocalContainerSandboxProvider(config);
		const handle = await provider.createSandbox("user-1", silentLogger);
		expect(handle).toEqual({ sandboxId: "local-sandbox" });
	});

	it("ensureSandboxDaemon returns the daemon endpoint once /health is ok", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 200 }),
		);
		const provider = new LocalContainerSandboxProvider(config);

		const endpoint = await provider.ensureSandboxDaemon(
			"user-1",
			{ sandboxId: "local-sandbox" },
			silentLogger,
		);

		expect(endpoint).toEqual({
			url: config.localSandboxDaemonUrl,
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			`${config.localSandboxDaemonUrl}/health`,
			expect.anything(),
		);
	});

	it("ensureSandboxDaemon keeps polling past transient fetch rejections, then succeeds", async () => {
		let calls = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			calls += 1;
			// First couple of polls: daemon not accepting connections yet.
			if (calls < 3) throw new Error("ECONNREFUSED");
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch);
		const provider = new LocalContainerSandboxProvider(config, {
			readyTimeoutMs: 1_000,
			pollIntervalMs: 5,
		});

		const endpoint = await provider.ensureSandboxDaemon(
			"user-1",
			{ sandboxId: "local-sandbox" },
			silentLogger,
		);

		expect(endpoint.url).toBe(config.localSandboxDaemonUrl);
		expect(calls).toBeGreaterThanOrEqual(3);
	});

	it("ensureSandboxDaemon throws if the daemon never becomes healthy", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 503 }),
		);
		const provider = new LocalContainerSandboxProvider(config, {
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
		const provider = new LocalContainerSandboxProvider(config);
		await expect(provider.killSandbox()).resolves.toBeUndefined();
	});

	it("cancelSandbox is a best-effort no-op (no per-turn abort on the shared container)", async () => {
		const provider = new LocalContainerSandboxProvider(config);
		await expect(
			provider.cancelSandbox(
				"user-1",
				{ sandboxId: "local-sandbox" },
				silentLogger,
			),
		).resolves.toBeUndefined();
	});
});
