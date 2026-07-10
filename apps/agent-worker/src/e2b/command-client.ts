import { CommandExitError, TimeoutError } from "e2b";
import type {
	ManagedCommandSpec,
	RawCommandOutcome,
	SandboxCommandClient,
	SandboxCommandSession,
} from "../bash-tool/bash-tool";
import {
	buildKillGroupCommand,
	buildReapCommand,
	parseReapSurvivors,
	WRAPPER_PROGRAM,
	wrapperEnv,
} from "../bash-tool/bash-wrapper";

/**
 * The slice of an E2B `Sandbox` the executor clients drive. A structural
 * subset of the real SDK class, so production code passes a `Sandbox` while
 * unit tests pass a fake without touching E2B — the provisioner
 * (sandbox-provisioner.ts) is the only module that ever holds the real thing.
 */
export interface CommandSandbox {
	commands: {
		run(
			cmd: string,
			opts?: {
				cwd?: string;
				envs?: Record<string, string>;
				timeoutMs?: number;
				onStdout?: (data: string) => void | Promise<void>;
				onStderr?: (data: string) => void | Promise<void>;
			},
		): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	};
}

/**
 * The real E2B-backed {@link SandboxCommandClient}, built on the shared
 * process-group wrapper module. Proven against live E2B by the Task 5.2
 * acceptance test (bash-tool.e2b.test.ts), which showed descendant cleanup
 * works through the wrapper where the raw SDK kill cannot do it; promoted to
 * production for the sandbox provisioner (Task 9.4).
 */
export class E2BCommandClient implements SandboxCommandClient {
	constructor(
		private readonly sandbox: CommandSandbox,
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
