import { describe, expect, it } from "bun:test";
import { loadConfigFromEnv } from "./config";

describe("loadConfigFromEnv", () => {
	it("applies defaults when the environment is empty", () => {
		const config = loadConfigFromEnv({});
		expect(config).toEqual({
			daemonPort: 8080,
			daemonVersion: "unknown",
			workspaceRoot: "/workspace",
			agentSpawn: {
				agentBundlePath: "/workspace/agent.js",
				bunExecutable: "bun",
				agentIdleTimeoutMs: 120_000,
				agentMaxTurnMs: 600_000,
			},
		});
	});

	it("reads each setting from its environment variable", () => {
		const config = loadConfigFromEnv({
			DAEMON_PORT: "9090",
			DAEMON_VERSION: "v1.2.3",
			SANDBOX_WORKSPACE_ROOT: "/tmp/ws",
			SANDBOX_AGENT_PATH: "/custom/agent.js",
			SANDBOX_BUN_PATH: "/custom/bun",
			SANDBOX_AGENT_IDLE_TIMEOUT_MS: "5000",
			SANDBOX_AGENT_MAX_TURN_MS: "60000",
		});
		expect(config).toEqual({
			daemonPort: 9090,
			daemonVersion: "v1.2.3",
			workspaceRoot: "/tmp/ws",
			agentSpawn: {
				agentBundlePath: "/custom/agent.js",
				bunExecutable: "/custom/bun",
				agentIdleTimeoutMs: 5000,
				agentMaxTurnMs: 60000,
			},
		});
	});

	it("falls back to the default port on a malformed DAEMON_PORT", () => {
		for (const bad of ["abc", "0", "-1", "70000", "1.5", ""]) {
			expect(loadConfigFromEnv({ DAEMON_PORT: bad }).daemonPort).toBe(8080);
		}
	});

	// A malformed watchdog value must fall back to the default, not become NaN/0
	// — setTimeout(fn, NaN|0) fires immediately and would SIGKILL every turn at
	// spawn. This is why the timeouts parse leniently (fall back) rather than throw.
	it("falls back to the default timeouts on malformed millisecond values", () => {
		for (const bad of ["abc", "0", "-100", ""]) {
			const { agentSpawn } = loadConfigFromEnv({
				SANDBOX_AGENT_IDLE_TIMEOUT_MS: bad,
				SANDBOX_AGENT_MAX_TURN_MS: bad,
			});
			expect(agentSpawn.agentIdleTimeoutMs).toBe(120_000);
			expect(agentSpawn.agentMaxTurnMs).toBe(600_000);
		}
	});
});
