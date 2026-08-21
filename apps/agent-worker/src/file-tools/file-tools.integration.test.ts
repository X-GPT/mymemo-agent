import { afterEach, describe, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { takeUtf8Bytes } from "../utf8";
import type {
	FileToolLimits,
	SandboxFileClient,
	SandboxFileCommand,
	SandboxFileCommandResult,
	SandboxFileRead,
	SandboxFileWrite,
} from "./file-tools";
import { runFileToolsContract } from "./testing";

class LocalCommandSandboxFileClient implements SandboxFileClient {
	async readFile(input: SandboxFileRead): Promise<string> {
		const bytes = await Bun.file(input.path).arrayBuffer();
		return new TextDecoder().decode(bytes.slice(0, input.maxBytes));
	}

	async writeFile(input: SandboxFileWrite): Promise<void> {
		await Bun.write(input.path, input.content);
	}

	async runCommand(
		input: SandboxFileCommand,
	): Promise<SandboxFileCommandResult> {
		const proc = Bun.spawn(["/bin/sh", "-lc", input.command], {
			cwd: input.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = setTimeout(() => proc.kill(), input.timeoutMs);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const bounded = takeUtf8Bytes(stdout, input.maxOutputBytes);
			return {
				exitCode,
				stdout: bounded.text,
				stderr,
				truncated: bounded.truncated,
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}

const limits: FileToolLimits = {
	readMaxBytes: 1024,
	readMaxLines: 200,
	grepMaxResults: 100,
	globMaxResults: 500,
	commandMaxOutputBytes: 16_384,
	commandTimeoutMs: 10_000,
};

let workspaceRoot: string | undefined;

afterEach(async () => {
	if (workspaceRoot) {
		await rm(workspaceRoot, { recursive: true, force: true });
		workspaceRoot = undefined;
	}
});

describe("command-backed file tools", () => {
	it("runs grep and glob against the real command path with bounded sorted results", async () => {
		workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mymemo-file-tools-"));

		await runFileToolsContract({
			client: new LocalCommandSandboxFileClient(),
			workspaceRoot,
			limits,
		});
	});
});
