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
			"/packages/agentcore-dispatch/src/sqs-queue.ts",
		]) {
			expect([...graph].some((file) => file.endsWith(forbidden))).toBe(false);
		}
	});
});
