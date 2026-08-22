import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { findFreePort } from "../../packages/test-support/redis-test-server";

const root = resolve(import.meta.dir, "../..");
const script = resolve(import.meta.dir, "local-agentcore-smoke.ts");
const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

describe("local AgentCore smoke", () => {
	it("pins the complete local Conversation suite", async () => {
		let memberCode: string | null = null;
		let partnerCode: string | null = null;
		const server = Bun.serve({
			port: await findFreePort(),
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/health") return new Response("ok");
				if (request.method === "POST" && url.pathname === "/v1/conversations") {
					memberCode = request.headers.get("x-member-code");
					partnerCode = request.headers.get("x-partner-code");
					return new Response("fixture stop", { status: 500 });
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);

		const child = Bun.spawn([process.execPath, "run", script], {
			cwd: root,
			env: {
				...Bun.env,
				AGENT_SMOKE_BASE_URL: `http://127.0.0.1:${server.port}`,
				AGENT_SMOKE_EXPECT_GATE_CLOSED: "true",
				AGENT_SMOKE_MEMBER_CODE: "wrong-member",
				AGENT_SMOKE_SUITE: "core",
				AGENT_SMOKE_TURN_TIMEOUT_MS: "5000",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);

		expect(exitCode).not.toBe(0);
		expect(memberCode).toBe("demo-member");
		expect(partnerCode).toBe("local-development");
		expect(stderr).toContain("expected conversation create 201, got 500");
	});
});
