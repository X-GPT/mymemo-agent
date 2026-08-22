import { describe, expect, it } from "bun:test";
import { findFreePort } from "@mymemo/test-support/redis-test-server";

describe("agent-maintenance production entrypoint", () => {
	it("starts and stops with only maintenance configuration", async () => {
		const port = await findFreePort();
		const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
			cwd: `${import.meta.dir}/..`,
			env: {
				AGENT_DATABASE_URL:
					"postgresql://agent@127.0.0.1:1/mymemo_agent?connect_timeout=1",
				DB_SSL: "disable",
				E2B_API_KEY: "entrypoint-test",
				ARTIFACT_BUCKET: "entrypoint-test",
				AWS_REGION: "us-west-2",
				LOG_LEVEL: "info",
				PORT: String(port),
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		await Bun.sleep(1_000);
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		expect(await health.json()).toEqual({
			status: "ok",
			service: "agent-maintenance",
		});
		child.kill("SIGTERM");
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(health.status).toBe(200);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain('"message":"agent-maintenance started"');
		expect(stdout).toContain('"message":"agent-maintenance stopped"');
	});
});
