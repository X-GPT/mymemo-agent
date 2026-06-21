import { describe, expect, it } from "bun:test";
import type { DaemonConfig } from "./config";
import { createDaemon } from "./daemon";

const baseConfig: DaemonConfig = {
	daemonPort: 8080,
	daemonVersion: "test-1.0",
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

	it("wires /turn (no app-layer auth; the sandbox edge is the boundary)", async () => {
		const app = createDaemon(baseConfig);
		// /turn is registered and validates the body — an incomplete body is
		// rejected with 400, not 404. There is no bearer check (MYM-35): the
		// sandbox edge gates the public URL upstream of the daemon.
		const res = await app.request("/turn", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});
		expect(res.status).toBe(400);
	});
});
