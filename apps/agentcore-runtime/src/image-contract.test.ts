import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceImportGraph } from "@mymemo/test-support/import-graph";

const root = join(import.meta.dir, "../../..");

describe("AgentCore Runtime image contract", () => {
	it("keeps global queue control modules out of the Runtime import graph", () => {
		const composition = [
			readFileSync(join(root, "apps/agentcore-runtime/src/index.ts"), "utf8"),
			readFileSync(
				join(root, "apps/agentcore-runtime/src/production.ts"),
				"utf8",
			),
		].join("\n");

		for (const forbidden of [
			"RunLoop",
			"MaintenanceRunner",
			"claimConversationTx",
			"expireUnownedQueuedRunsTx",
			"reclaimConversationTx",
		]) {
			expect(composition).not.toContain(forbidden);
		}
		const graph = workspaceImportGraph(
			root,
			join(root, "apps/agentcore-runtime/src/index.ts"),
		);
		for (const forbidden of [
			"/apps/agent-worker/src/run-loop.ts",
			"/apps/agent-worker/src/maintenance-runner.ts",
			"/packages/agentcore-dispatch/src/sqs-queue.ts",
		]) {
			expect([...graph].some((file) => file.endsWith(forbidden))).toBe(false);
		}
	});
});
