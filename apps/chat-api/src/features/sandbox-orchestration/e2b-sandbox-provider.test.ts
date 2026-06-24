import { afterEach, describe, expect, it, mock } from "bun:test";

// Mock the e2b SDK so createSandbox is exercised without leasing a real sandbox.
// createImpl is swapped per test to drive the create result; sandboxKill records
// the fail-closed teardown. mock.module is declared before the provider import
// (matching the project's other module-mock tests) so the import binds the mock.
const sandboxKill = mock(async () => {});
let createImpl: () => Promise<unknown> = async () => ({});
const sandboxCreate = mock(() => createImpl());
let connectImpl: () => Promise<unknown> = async () => ({});
const sandboxConnect = mock(() => connectImpl());
mock.module("e2b", () => ({
	Sandbox: { create: sandboxCreate, connect: sandboxConnect },
}));

import type { ApiConfig } from "@/config/env";
import { E2BSandboxProvider } from "./e2b-sandbox-provider";
import { SandboxCreationError } from "./errors";
import type { SyncLogger } from "./sandbox-provider";

const silentLogger: SyncLogger = { info: () => {}, error: () => {} };
// createSandbox only reads e2bTemplate; the rest of ApiConfig is irrelevant here.
const config = { e2bTemplate: "tpl" } as unknown as ApiConfig;

function fakeSandbox(overrides: Record<string, unknown> = {}) {
	return {
		sandboxId: "sbx-1",
		trafficAccessToken: "traffic-token",
		kill: sandboxKill,
		...overrides,
	};
}

describe("E2BSandboxProvider.createSandbox", () => {
	afterEach(() => {
		sandboxCreate.mockClear();
		sandboxKill.mockClear();
	});

	it("creates the sandbox with public traffic restricted", async () => {
		createImpl = async () => fakeSandbox();
		await new E2BSandboxProvider(config).createSandbox("user-1", silentLogger);
		expect(sandboxCreate).toHaveBeenCalledWith(
			"tpl",
			expect.objectContaining({ network: { allowPublicTraffic: false } }),
		);
	});

	it("returns the handle when the traffic token is present", async () => {
		createImpl = async () =>
			fakeSandbox({ trafficAccessToken: "traffic-token" });
		const handle = await new E2BSandboxProvider(config).createSandbox(
			"user-1",
			silentLogger,
		);
		expect(handle.sandboxId).toBe("sbx-1");
		expect(sandboxKill).not.toHaveBeenCalled();
	});

	// The security-critical guard: a sandbox whose public-traffic restriction did
	// not take effect (no token minted) must be killed and fail closed. The error
	// is deliberately a plain Error, NOT SandboxCreationError, so runSandboxChat
	// does not retry an identical, deterministic create.
	it("fails closed (no retry) and kills the sandbox when the traffic token is absent", async () => {
		createImpl = async () => fakeSandbox({ trafficAccessToken: undefined });
		const err = await new E2BSandboxProvider(config)
			.createSandbox("user-1", silentLogger)
			.catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(SandboxCreationError);
		expect((err as Error).message).toMatch(/did not take effect/);
		expect(sandboxKill).toHaveBeenCalled();
	});

	it("wraps a create() failure in the retryable SandboxCreationError", async () => {
		createImpl = async () => {
			throw new Error("e2b unavailable");
		};
		const err = await new E2BSandboxProvider(config)
			.createSandbox("user-1", silentLogger)
			.catch((e) => e);

		expect(err).toBeInstanceOf(SandboxCreationError);
		expect(sandboxKill).not.toHaveBeenCalled();
	});
});

describe("E2BSandboxProvider.connectSandbox", () => {
	afterEach(() => {
		sandboxConnect.mockClear();
	});

	it("returns the reconnected handle when the traffic token is present", async () => {
		connectImpl = async () =>
			fakeSandbox({ trafficAccessToken: "traffic-token" });
		const handle = await new E2BSandboxProvider(config).connectSandbox(
			"sbx-1",
			silentLogger,
		);
		expect(handle.sandboxId).toBe("sbx-1");
	});

	// Parity with createSandbox's invariant: a reconnect that comes back without
	// the per-sandbox edge token is unreachable, so it must throw — the lease
	// manager then treats the lease as stale and recreates instead of reusing a
	// sandbox whose every turn would 403 at the edge.
	it("throws when the reconnected sandbox has no traffic token", async () => {
		connectImpl = async () => fakeSandbox({ trafficAccessToken: undefined });
		const err = await new E2BSandboxProvider(config)
			.connectSandbox("sbx-1", silentLogger)
			.catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/no trafficAccessToken/);
	});
});
