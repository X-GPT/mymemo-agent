import { CommandExitError } from "e2b";
import type {
	SandboxFileClient,
	SandboxFileCommand,
	SandboxFileCommandResult,
	SandboxFileRead,
	SandboxFileWrite,
} from "../file-tools/file-tools";
import { takeUtf8Bytes } from "../file-tools/file-tools";
import type { CommandSandbox } from "./command-client";

/** The slice of an E2B `Sandbox` the file client drives: the files API plus
 * command execution (Grep/Glob shell out to `rg`/`python3` in the sandbox). */
export interface FileSandbox extends CommandSandbox {
	files: {
		read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
		write(path: string, data: string): Promise<unknown>;
	};
}

/**
 * The real E2B-backed {@link SandboxFileClient} (Task 9.4): reads and writes go
 * through the sandbox files API, and the Grep/Glob command path goes through
 * `commands.run`. Exit-code interpretation belongs to the file tools, so a
 * non-zero exit comes back as a result — only transport failures throw.
 */
export class E2BFileClient implements SandboxFileClient {
	constructor(private readonly sandbox: FileSandbox) {}

	async readFile(input: SandboxFileRead): Promise<string> {
		// The whole file crosses the wire; `maxBytes` bounds what we hold and
		// return, mirroring the contract's local reference client.
		const bytes = await this.sandbox.files.read(input.path, {
			format: "bytes",
		});
		return new TextDecoder().decode(bytes.slice(0, input.maxBytes));
	}

	async writeFile(input: SandboxFileWrite): Promise<void> {
		await this.sandbox.files.write(input.path, input.content);
	}

	async runCommand(
		input: SandboxFileCommand,
	): Promise<SandboxFileCommandResult> {
		try {
			const result = await this.sandbox.commands.run(input.command, {
				cwd: input.cwd,
				timeoutMs: input.timeoutMs,
			});
			return boundedCommandResult(result, input.maxOutputBytes);
		} catch (error) {
			if (error instanceof CommandExitError) {
				return boundedCommandResult(error, input.maxOutputBytes);
			}
			throw error;
		}
	}
}

function boundedCommandResult(
	result: { exitCode: number; stdout: string; stderr: string },
	maxOutputBytes: number,
): SandboxFileCommandResult {
	const stdout = takeUtf8Bytes(result.stdout, maxOutputBytes);
	const stderr = takeUtf8Bytes(result.stderr, maxOutputBytes);
	return {
		exitCode: result.exitCode,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: stdout.truncated,
	};
}
