import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

describe("AgentCore Runtime image contract", () => {
	it("builds a distinct ARM64 request-oriented image with pinned runtime dependencies", () => {
		const dockerfile = readFileSync(
			join(root, "apps/agentcore-canary-runtime/Dockerfile"),
			"utf8",
		);

		expect(dockerfile).toContain(
			'LABEL com.mymemo.agentcore-runtime.request-oriented="true"',
		);
		expect(dockerfile).toContain(
			"ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3",
		);
		expect(dockerfile).toContain('ENTRYPOINT [ "bun", "run", "src/index.ts" ]');
		expect(dockerfile).toContain("EXPOSE 8080/tcp");
		expect(dockerfile).not.toContain("apps/agent-worker/src/index.ts");
	});

	it("keeps global queue control behavior out of the Runtime entrypoint", () => {
		const composition = [
			readFileSync(
				join(root, "apps/agentcore-canary-runtime/src/index.ts"),
				"utf8",
			),
			readFileSync(
				join(root, "apps/agentcore-canary-runtime/src/production.ts"),
				"utf8",
			),
		].join("\n");

		for (const forbidden of [
			"RunLoop",
			"CleanupLoop",
			"claimConversationTx",
			"expireUnownedQueuedRunsTx",
			"reclaimConversationTx",
		]) {
			expect(composition).not.toContain(forbidden);
		}
	});

	it("has a path-filtered ARM64 build and offline image verification gate", () => {
		const smokePath = join(
			root,
			"scripts/smoke/agentcore-canary-runtime-image-check.sh",
		);
		const workflowPath = join(
			root,
			".github/workflows/agentcore-runtime-image.yml",
		);
		expect(existsSync(smokePath)).toBe(true);
		expect(existsSync(workflowPath)).toBe(true);
		const smoke = readFileSync(smokePath, "utf8");
		const workflow = readFileSync(workflowPath, "utf8");
		expect(smoke).toContain("--network none");
		expect(smoke).toContain("resolveAndVerifyClaudeCodeExecutable");
		expect(smoke).toContain("test src/server.test.ts");
		expect(smoke).toContain("/ping");
		expect(smoke).toContain("/invocations");
		expect(workflow).toContain("platforms: linux/arm64");
		expect(workflow).toContain("agentcore-canary-runtime-image-check.sh");
	});
});
