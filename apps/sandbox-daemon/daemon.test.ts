import { describe, expect, it } from "bun:test";
import type { DaemonConfig } from "./config";
import { createDaemon } from "./daemon";

const baseConfig: DaemonConfig = {
	daemonPort: 8080,
	daemonVersion: "test-1.0",
	daemonAuthToken: "secret",
	workspaceRoot: "/tmp/ws",
	agentSpawn: {
		agentBundlePath: "/workspace/agent.js",
		bunExecutable: "bun",
		agentIdleTimeoutMs: 120_000,
		agentMaxTurnMs: 600_000,
	},
};

describe("createDaemon", () => {
	it("serves /health with the injected version", async () => {
		const app = createDaemon(baseConfig);
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.version).toBe("test-1.0");
		expect(typeof body.uptime).toBe("number");
	});

	it("serves /current with the lock state", async () => {
		const app = createDaemon(baseConfig);
		const res = await app.request("/current");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("busy");
	});

	it("wires /turn so the injected auth token is enforced", async () => {
		const app = createDaemon(baseConfig);
		// No bearer header → the turn route rejects before any spawn.
		const res = await app.request("/turn", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});
		expect(res.status).toBe(401);
	});
});
