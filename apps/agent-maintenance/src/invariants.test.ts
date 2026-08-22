import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { workspaceImportGraph } from "@mymemo/test-support/import-graph";

const root = join(import.meta.dir, "../../..");

describe("agent-maintenance boundary", () => {
	it("has no Run-serving, model, knowledge-base, Redis, or Dispatch path", () => {
		const graph = workspaceImportGraph(root, join(import.meta.dir, "main.ts"));
		const forbidden = [
			"/run-loop.ts",
			"/run-serving.ts",
			"/model-client.ts",
			"/documents/",
			"/production-run-resources.ts",
			"/agentcore-dispatch/",
			"/live-text/",
		];

		for (const path of graph) {
			for (const fragment of forbidden) expect(path).not.toContain(fragment);
		}
	});
});
