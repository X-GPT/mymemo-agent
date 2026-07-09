// Live E2B test (Task 5.2 acceptance): proves descendant cleanup works THROUGH
// the process-group wrapper — the case the Task 4.1 spike (p6) showed the raw
// SDK cannot do (a backgrounded child survives timeout/kill and reparents to
// init). Skipped unless E2B_API_KEY is set, so CI without E2B credentials
// passes; run locally with `E2B_API_KEY=... bun test bash-tool.e2b`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CommandExitError, Sandbox, TimeoutError } from "e2b";
import {
	type BashToolContext,
	type CommandAuditEvent,
	type ManagedCommandSpec,
	type RawCommandOutcome,
	runBashTool,
	type SandboxCommandClient,
	type SandboxCommandSession,
} from "./bash-tool";
import {
	buildKillGroupCommand,
	buildReapCommand,
	DEFAULT_COMMAND_CONTROL_DIR,
	parseReapSurvivors,
	WRAPPER_PROGRAM,
	wrapperEnv,
} from "./bash-wrapper";

const LIVE = !!process.env.E2B_API_KEY;
const TEMPLATE = process.env.E2B_TEMPLATE ?? "base";
const WORKSPACE_ROOT = "/home/user";
const TEST_TIMEOUT_MS = 180_000;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** A real E2B-backed command client, built on the shared wrapper module. This
 * is the substrate the pure `runBashTool` handler is designed against; it lives
 * in the test (like the file-tools integration client) until the sandbox
 * lifecycle is wired in a later milestone. */
class E2BCommandClient implements SandboxCommandClient {
	constructor(
		private readonly sandbox: Sandbox,
		private readonly controlDir: string,
	) {}

	start(spec: ManagedCommandSpec): SandboxCommandSession {
		const outcome = this.run(spec);
		return {
			outcome,
			kill: async () => {
				await this.sandbox.commands.run(
					buildKillGroupCommand({
						commandId: spec.commandId,
						controlDir: this.controlDir,
						graceMs: 1_000,
					}),
				);
			},
			reap: async () => {
				const result = await this.sandbox.commands.run(
					buildReapCommand({
						commandId: spec.commandId,
						controlDir: this.controlDir,
					}),
				);
				return { survivors: parseReapSurvivors(result.stdout) };
			},
		};
	}

	private async run(spec: ManagedCommandSpec): Promise<RawCommandOutcome> {
		let stdout = "";
		let stderr = "";
		try {
			const result = await this.sandbox.commands.run(WRAPPER_PROGRAM, {
				cwd: spec.cwd,
				envs: wrapperEnv({
					command: spec.command,
					commandId: spec.commandId,
					controlDir: this.controlDir,
				}),
				// Backstop beyond the tool's own timer so a truly hung command is
				// still bounded even if the group kill is somehow ineffective.
				timeoutMs: spec.timeoutMs + 5_000,
				onStdout: (data) => {
					stdout += data;
				},
				onStderr: (data) => {
					stderr += data;
				},
			});
			return {
				exitCode: result.exitCode,
				stdout,
				stderr,
				stdoutTruncated: false,
				stderrTruncated: false,
				timedOut: false,
			};
		} catch (error) {
			if (error instanceof CommandExitError) {
				return {
					exitCode: error.exitCode,
					stdout,
					stderr,
					stdoutTruncated: false,
					stderrTruncated: false,
					timedOut: false,
				};
			}
			if (error instanceof TimeoutError) {
				return {
					exitCode: null,
					stdout,
					stderr,
					stdoutTruncated: false,
					stderrTruncated: false,
					timedOut: true,
				};
			}
			throw error;
		}
	}
}

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
	const result = await sandbox.commands.run(
		`pgrep -f -c ${JSON.stringify(pattern)} || true`,
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
