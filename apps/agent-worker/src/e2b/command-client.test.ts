import { describe, expect, it } from "bun:test";
import { CommandExitError, TimeoutError } from "e2b";
import type { ManagedCommandSpec } from "../bash-tool/bash-tool";
import {
	buildKillGroupCommand,
	buildReapCommand,
	DEFAULT_COMMAND_CONTROL_DIR,
	WRAPPER_PROGRAM,
	wrapperEnv,
} from "../bash-tool/bash-wrapper";
import { type CommandSandbox, E2BCommandClient } from "./command-client";

type RunCall = {
	cmd: string;
	opts?: {
		cwd?: string;
		envs?: Record<string, string>;
		timeoutMs?: number;
		onStdout?: (data: string) => void | Promise<void>;
		onStderr?: (data: string) => void | Promise<void>;
	};
};

/** A fake E2B sandbox whose `commands.run` replays a scripted response after
 * streaming the given output through the callbacks, as the real SDK does. */
function makeFakeSandbox(
	respond: (call: RunCall) => Promise<{ exitCode: number; stdout?: string }>,
): {
	sandbox: CommandSandbox;
	calls: RunCall[];
} {
	const calls: RunCall[] = [];
	return {
		calls,
		sandbox: {
			commands: {
				run: async (cmd, opts) => {
					const call = { cmd, opts };
					calls.push(call);
					const result = await respond(call);
					return {
						exitCode: result.exitCode,
						stdout: result.stdout ?? "",
						stderr: "",
					};
				},
			},
		},
	};
}

const spec: ManagedCommandSpec = {
	commandId: "cmd-1",
	command: "echo hi",
	cwd: "/home/user",
	timeoutMs: 10_000,
	maxStdoutBytes: 65_536,
	maxStderrBytes: 65_536,
};

describe("E2BCommandClient", () => {
	it("runs the wrapper program with the command in env and a backstop timeout", async () => {
		const { sandbox, calls } = makeFakeSandbox(async (call) => {
			await call.opts?.onStdout?.("hi\n");
			return { exitCode: 0 };
		});
		const client = new E2BCommandClient(sandbox, DEFAULT_COMMAND_CONTROL_DIR);

		const outcome = await client.start(spec).outcome;

		expect(calls[0]?.cmd).toBe(WRAPPER_PROGRAM);
		expect(calls[0]?.opts?.cwd).toBe(spec.cwd);
		expect(calls[0]?.opts?.timeoutMs).toBe(spec.timeoutMs + 5_000);
		expect(calls[0]?.opts?.envs).toEqual(
			wrapperEnv({
				command: spec.command,
				commandId: spec.commandId,
				controlDir: DEFAULT_COMMAND_CONTROL_DIR,
			}),
		);
		expect(outcome).toEqual({
			exitCode: 0,
			stdout: "hi\n",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			timedOut: false,
		});
	});

	it("maps a non-zero-exit throw to an exit-code outcome with streamed output", async () => {
		const { sandbox } = makeFakeSandbox(async (call) => {
			await call.opts?.onStderr?.("boom\n");
			throw new CommandExitError({ exitCode: 7, stdout: "", stderr: "" });
		});
		const client = new E2BCommandClient(sandbox, DEFAULT_COMMAND_CONTROL_DIR);

		const outcome = await client.start(spec).outcome;

		expect(outcome.exitCode).toBe(7);
		expect(outcome.stderr).toBe("boom\n");
		expect(outcome.timedOut).toBe(false);
	});

	it("maps the SDK backstop timeout to a timedOut outcome with a null exit code", async () => {
		const { sandbox } = makeFakeSandbox(async () => {
			throw new TimeoutError("command timed out");
		});
		const client = new E2BCommandClient(sandbox, DEFAULT_COMMAND_CONTROL_DIR);

		const outcome = await client.start(spec).outcome;

		expect(outcome.exitCode).toBeNull();
		expect(outcome.timedOut).toBe(true);
	});

	it("propagates transport failures instead of shaping them into outcomes", async () => {
		const { sandbox } = makeFakeSandbox(async () => {
			throw new Error("connection lost");
		});
		const client = new E2BCommandClient(sandbox, DEFAULT_COMMAND_CONTROL_DIR);

		await expect(client.start(spec).outcome).rejects.toThrow("connection lost");
	});

	it("kill and reap act on the command's process group via the control dir", async () => {
		const { sandbox, calls } = makeFakeSandbox(async (call) =>
			call.cmd === WRAPPER_PROGRAM
				? { exitCode: 0 }
				: { exitCode: 0, stdout: "0\n" },
		);
		const client = new E2BCommandClient(sandbox, DEFAULT_COMMAND_CONTROL_DIR);
		const session = client.start(spec);
		await session.outcome;

		await session.kill();
		const { survivors } = await session.reap();

		expect(calls.map((call) => call.cmd)).toEqual([
			WRAPPER_PROGRAM,
			buildKillGroupCommand({
				commandId: spec.commandId,
				controlDir: DEFAULT_COMMAND_CONTROL_DIR,
				graceMs: 1_000,
			}),
			buildReapCommand({
				commandId: spec.commandId,
				controlDir: DEFAULT_COMMAND_CONTROL_DIR,
			}),
		]);
		expect(survivors).toBe(0);
	});
});
