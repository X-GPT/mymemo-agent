import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { findFreePort } from "../../../packages/test-support/redis-test-server";

it("starts without Compose-only endpoints", async () => {
	const port = await findFreePort();
	const { LOCAL_ARTIFACT_ENDPOINT: _, ...processEnv } = Bun.env;
	const child = Bun.spawn([process.execPath, "run", "local/index.ts"], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...processEnv,
			AGENT_DATABASE_URL: "postgresql://local:local@127.0.0.1:9/local",
			ARTIFACT_BUCKET: "test-artifacts",
			AWS_REGION: "us-west-2",
			DB_SSL: "disable",
			LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS: "true",
			OPENROUTER_API_KEY: "test-openrouter-key",
			PORT: String(port),
			REDIS_URL: "redis://127.0.0.1:9",
			VERCEL_PROJECT_ID: "prj_test",
			VERCEL_TEAM_ID: "team_test",
			VERCEL_TOKEN: "test-vercel-token",
		},
		stdout: "ignore",
		stderr: "pipe",
	});

	try {
		const deadline = Date.now() + 3_000;
		let healthy = false;
		while (Date.now() < deadline && child.exitCode === null) {
			try {
				healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
				if (healthy) break;
			} catch {}
			await Bun.sleep(50);
		}

		const stderr =
			child.exitCode === null ? "" : await new Response(child.stderr).text();
		expect(stderr).not.toContain("LOCAL_ARTIFACT_ENDPOINT is required");
		expect(healthy).toBe(true);
	} finally {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
});
