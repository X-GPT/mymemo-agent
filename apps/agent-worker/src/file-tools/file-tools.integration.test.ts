import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	type FileToolLimits,
	runGlobFileTool,
	runGrepFileTool,
	type SandboxFileClient,
	type SandboxFileCommand,
	type SandboxFileCommandResult,
	type SandboxFileRead,
	type SandboxFileWrite,
} from "./file-tools";

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
			const bounded = boundOutput(stdout, input.maxOutputBytes);
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

function parseResult(result: { content: { text: string }[] }) {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

function boundOutput(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const encoder = new TextEncoder();
	let bytes = 0;
	let output = "";
	for (const char of text) {
		const nextBytes = encoder.encode(char).byteLength;
		if (bytes + nextBytes > maxBytes) {
			return { text: output, truncated: true };
		}
		bytes += nextBytes;
		output += char;
	}
	return { text: output, truncated: false };
}

describe("command-backed file tools", () => {
	it("runs grep and glob against the real command path with bounded sorted results", async () => {
		workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mymemo-file-tools-"));
		await mkdir(path.join(workspaceRoot, "src"));
		await Bun.write(path.join(workspaceRoot, "notes.txt"), "alpha\nbeta\n");
		await Bun.write(path.join(workspaceRoot, "src", "memo.txt"), "alpha\n");
		await Bun.write(path.join(workspaceRoot, ".hidden.txt"), "alpha\n");

		const context = {
			client: new LocalCommandSandboxFileClient(),
			workspaceRoot,
			limits,
			markWorkspaceDirty: async () => {},
		};

		const grepResult = await runGrepFileTool(
			{ pattern: "alpha", maxResults: 10 },
			context,
		);
		expect(grepResult.isError).toBeUndefined();
		expect(parseResult(grepResult)).toEqual({
			matches: [
				{ path: "notes.txt", line: 1, column: 1, text: "alpha" },
				{ path: "src/memo.txt", line: 1, column: 1, text: "alpha" },
			],
			truncated: false,
		});

		const globResult = await runGlobFileTool(
			{ pattern: "**/*.txt", maxResults: 10 },
			context,
		);
		expect(globResult.isError).toBeUndefined();
		expect(parseResult(globResult)).toEqual({
			paths: ["notes.txt", "src/memo.txt"],
			truncated: false,
		});
	});
});
