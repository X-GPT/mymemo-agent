import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "../../..");

function resolveWorkspaceImport(from: string, request: string): string | null {
	if (request.startsWith(".")) {
		const target = resolve(dirname(from), request);
		for (const candidate of [
			target,
			`${target}.ts`,
			join(target, "index.ts"),
		]) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}
	try {
		return Bun.resolveSync(request, dirname(from));
	} catch {
		return null;
	}
}

function runtimeImportGraph(): Set<string> {
	const entrypoint = join(root, "apps/agentcore-canary-runtime/src/index.ts");
	const graph = new Set<string>();
	const pending = [entrypoint];
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	while (pending.length > 0) {
		const file = pending.pop();
		if (!file || graph.has(file)) continue;
		graph.add(file);
		for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
			const resolved = resolveWorkspaceImport(file, imported.path);
			if (
				resolved?.startsWith(`${root}/`) &&
				!resolved.includes("/node_modules/") &&
				/\.[cm]?[jt]sx?$/.test(resolved) &&
				!graph.has(resolved)
			) {
				pending.push(resolved);
			}
		}
	}
	return graph;
}

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

	it("keeps global queue control modules out of the Runtime import graph", () => {
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
		const graph = runtimeImportGraph();
		for (const forbidden of [
			"/apps/agent-worker/src/run-loop.ts",
			"/apps/agent-worker/src/cleanup-loop.ts",
		]) {
			expect([...graph].some((file) => file.endsWith(forbidden))).toBe(false);
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
		expect(smoke).toContain('signal !== "SIGSEGV"');
		expect(workflow).toContain("platforms: linux/arm64");
		expect(workflow).toContain("agentcore-canary-runtime-image-check.sh");
		expect(workflow).toContain("  push:\n    branches:\n      - main");
	});
});
