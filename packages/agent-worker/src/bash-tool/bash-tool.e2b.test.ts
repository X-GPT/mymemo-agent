// Live E2B test (Task 5.2 acceptance): proves descendant cleanup works THROUGH
// the process-group wrapper — the case the Task 4.1 spike (p6) showed the raw
// SDK cannot do (a backgrounded child survives timeout/kill and reparents to
// init). Skipped unless E2B_API_KEY is set, so CI without E2B credentials
// passes; run locally with `E2B_API_KEY=... bun test bash-tool.e2b`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Sandbox } from "e2b";
import { E2BCommandClient } from "../e2b/command-client";
import {
	type BashToolContext,
	type CommandAuditEvent,
	runBashTool,
} from "./bash-tool";
import { DEFAULT_COMMAND_CONTROL_DIR } from "./bash-wrapper";

const LIVE = !!process.env.E2B_API_KEY;
const TEMPLATE = process.env.E2B_TEMPLATE ?? "base";
const WORKSPACE_ROOT = "/home/user";
const TEST_TIMEOUT_MS = 180_000;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function makeContext(
	sandbox: Sandbox,
	signal: AbortSignal,
): { context: BashToolContext; taints: string[]; audits: CommandAuditEvent[] } {
	const taints: string[] = [];
	const audits: CommandAuditEvent[] = [];
	const context: BashToolContext = {
		client: new E2BCommandClient(sandbox, DEFAULT_COMMAND_CONTROL_DIR),
		workspaceRoot: WORKSPACE_ROOT,
		binding: {
			userId: "user-live",
			conversationId: "conv-live",
			runId: "run-live",
			sandboxId: sandbox.sandboxId,
		},
		limits: {
			systemMaxTimeoutMs: 120_000,
			maxStdoutBytes: 65_536,
			maxStderrBytes: 65_536,
		},
		signal,
		markSandboxTainted: async (reason: string) => {
			taints.push(reason);
		},
		recordCommandAudit: async (event: CommandAuditEvent) => {
			audits.push(event);
		},
	};
	return { context, taints, audits };
}

async function countProcesses(
	sandbox: Sandbox,
	pattern: string,
): Promise<number> {
	// Bracket the first character ("[s]leep 3131") so the pattern does not match
	// the shell envd runs this very command through — its command line carries
	// the pattern text and would otherwise inflate every count by one.
	const selfExcluding = `[${pattern.slice(0, 1)}]${pattern.slice(1)}`;
	const result = await sandbox.commands.run(
		`pgrep -f -c ${JSON.stringify(selfExcluding)} || true`,
	);
	return Number.parseInt(result.stdout.trim() || "0", 10);
}

describe.skipIf(!LIVE)("Bash tool against live E2B", () => {
	let sandbox: Sandbox;

	beforeAll(async () => {
		sandbox = await Sandbox.create(TEMPLATE, {
			timeoutMs: 120_000,
			metadata: { test: "bash-tool-5.2" },
		});
	});

	afterAll(async () => {
		if (sandbox) {
			await Sandbox.kill(sandbox.sandboxId).catch(() => {});
		}
	});

	it(
		"kills a cancelled command's whole process tree, leaving no descendants",
		async () => {
			const controller = new AbortController();
			const { context, taints } = makeContext(sandbox, controller.signal);

			// Two backgrounded grandchildren + wait: exactly the spike's p6 shape,
			// which survived raw timeout/kill and reparented to init.
			const marker = "sleep 3131";
			const running = runBashTool(
				{ command: `${marker} & ${marker} & wait` },
				context,
			);

			// Wait for the descendants to actually be running, then cancel.
			let spawned = 0;
			for (let attempt = 0; attempt < 20 && spawned < 2; attempt++) {
				await sleep(500);
				spawned = await countProcesses(sandbox, marker);
			}
			expect(spawned).toBeGreaterThanOrEqual(2);

			controller.abort();
			const result = await running;

			expect(JSON.parse(result.content[0]?.text ?? "{}").outcome).toBe(
				"canceled",
			);
			expect(taints).toEqual([]);

			// The proof: no descendant survived the group kill.
			const survivors = await countProcesses(sandbox, marker);
			expect(survivors).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs a normal command to completion with bounded output",
		async () => {
			const controller = new AbortController();
			const { context, taints } = makeContext(sandbox, controller.signal);

			const result = await runBashTool({ command: "echo hello-e2b" }, context);

			const parsed = JSON.parse(result.content[0]?.text ?? "{}");
			expect(result.isError).toBeUndefined();
			expect(parsed.exitCode).toBe(0);
			expect(parsed.stdout).toContain("hello-e2b");
			expect(parsed.outcome).toBe("completed");
			expect(taints).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);
});
