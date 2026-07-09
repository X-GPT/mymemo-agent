import { describe, expect, it } from "bun:test";
import {
	runEditFileTool,
	runGlobFileTool,
	runGrepFileTool,
	runReadFileTool,
	runWriteFileTool,
	type SandboxFileClient,
	type SandboxFileCommand,
	type SandboxFileCommandResult,
	type SandboxFileRead,
	type SandboxFileWrite,
} from "./file-tools";

class FakeSandboxFileClient implements SandboxFileClient {
	readonly reads: SandboxFileRead[] = [];
	readonly writes: SandboxFileWrite[] = [];
	readonly commands: SandboxFileCommand[] = [];
	writeError: Error | undefined;
	commandError: Error | undefined;
	commandResult: SandboxFileCommandResult = {
		exitCode: 0,
		stdout: "",
		stderr: "",
		truncated: false,
	};

	constructor(private readonly readContent = "") {}

	async readFile(input: SandboxFileRead): Promise<string> {
		this.reads.push(input);
		return this.readContent;
	}

	async writeFile(input: SandboxFileWrite): Promise<void> {
		this.writes.push(input);
		if (this.writeError) throw this.writeError;
	}

	async runCommand(
		input: SandboxFileCommand,
	): Promise<SandboxFileCommandResult> {
		this.commands.push(input);
		if (this.commandError) throw this.commandError;
		return this.commandResult;
	}
}

const baseContext = {
	workspaceRoot: "/workspace",
	limits: {
		readMaxBytes: 12,
		readMaxLines: 2,
		grepMaxResults: 100,
		globMaxResults: 500,
		commandMaxOutputBytes: 16_384,
		commandTimeoutMs: 10_000,
	},
};

function parseResult(result: { content: { text: string }[] }) {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

describe("Read file tool", () => {
	it("rejects path traversal before calling the sandbox", async () => {
		const client = new FakeSandboxFileClient();

		const result = await runReadFileTool(
			{ path: "../secret.txt" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"path must stay inside workspace",
		);
		expect(client.reads).toEqual([]);
		expect(client.commands).toEqual([]);
	});

	it("rejects absolute paths outside the workspace before calling the sandbox", async () => {
		const client = new FakeSandboxFileClient();

		const result = await runReadFileTool(
			{ path: "/etc/passwd" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"path must stay inside workspace",
		);
		expect(client.reads).toEqual([]);
		expect(client.commands).toEqual([]);
	});

	it("applies byte and line caps to returned content", async () => {
		const client = new FakeSandboxFileClient("alpha\nbravo\ncharlie\n");

		const result = await runReadFileTool(
			{ path: "notes.txt" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBeUndefined();
		expect(client.reads).toEqual([
			{ path: "/workspace/notes.txt", maxBytes: 13 },
		]);
		expect(parseResult(result)).toEqual({
			path: "notes.txt",
			content: "alpha\nbravo",
			startLine: 1,
			linesRead: 2,
			truncated: true,
		});
	});
});

describe("Write file tool", () => {
	it("writes the file through the sandbox client", async () => {
		const client = new FakeSandboxFileClient();

		const result = await runWriteFileTool(
			{ path: "notes.txt", content: "hello" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBeUndefined();
		expect(client.writes).toEqual([
			{ path: "/workspace/notes.txt", content: "hello" },
		]);
		expect(parseResult(result)).toEqual({
			path: "notes.txt",
			bytesWritten: 5,
		});
	});

	it("returns a bounded error when the sandbox write fails", async () => {
		const client = new FakeSandboxFileClient();
		client.writeError = new Error("E2B write exploded with a long detail");

		const result = await runWriteFileTool(
			{ path: "notes.txt", content: "hello" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(
			"Write failed: E2B write exploded with a long detail",
		);
	});
});

describe("Edit file tool", () => {
	it("replaces all exact matches", async () => {
		const client = new FakeSandboxFileClient("hello hello");

		const result = await runEditFileTool(
			{ path: "notes.txt", oldText: "hello", newText: "hi" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBeUndefined();
		expect(client.reads).toEqual([
			{ path: "/workspace/notes.txt", maxBytes: 13 },
		]);
		expect(client.writes).toEqual([
			{ path: "/workspace/notes.txt", content: "hi hi" },
		]);
		expect(parseResult(result)).toEqual({
			path: "notes.txt",
			replacements: 2,
		});
	});

	it("returns an error when the replacement write fails", async () => {
		const client = new FakeSandboxFileClient("hello");
		client.writeError = new Error("E2B write failed");

		const result = await runEditFileTool(
			{ path: "notes.txt", oldText: "hello", newText: "hi" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBe(true);
	});
});

describe("Grep file tool", () => {
	it("returns deterministic bounded matches from command output", async () => {
		const client = new FakeSandboxFileClient();
		client.commandResult = {
			exitCode: 0,
			stderr: "",
			truncated: false,
			stdout: "b.txt\t2\t2\tbeta\na.txt\t1\t1\talpha\n",
		};

		const result = await runGrepFileTool(
			{ pattern: "a", path: ".", maxResults: 1 },
			{ ...baseContext, client },
		);

		expect(result.isError).toBeUndefined();
		expect(client.commands).toHaveLength(1);
		expect(client.commands[0]?.cwd).toBe("/workspace");
		expect(client.commands[0]?.maxOutputBytes).toBe(16_384);
		expect(parseResult(result)).toEqual({
			matches: [{ path: "a.txt", line: 1, column: 1, text: "alpha" }],
			truncated: true,
		});
	});

	it("converts sandbox command errors into bounded tool errors", async () => {
		const client = new FakeSandboxFileClient();
		client.commandError = new Error(`E2B unavailable ${"x".repeat(400)}`);

		const result = await runGrepFileTool(
			{ pattern: "needle" },
			{ ...baseContext, client },
		);

		expect(result.isError).toBe(true);
		expect(
			result.content[0]?.text.startsWith("Grep failed: E2B unavailable"),
		).toBe(true);
		expect(result.content[0]?.text.length).toBeLessThan(280);
	});
});

describe("Glob file tool", () => {
	it("returns deterministic bounded paths from command output", async () => {
		const client = new FakeSandboxFileClient();
		client.commandResult = {
			exitCode: 0,
			stdout: "z.txt\nb.txt\na.txt\n",
			stderr: "",
			truncated: false,
		};

		const result = await runGlobFileTool(
			{ pattern: "*.txt", maxResults: 2 },
			{ ...baseContext, client },
		);

		expect(result.isError).toBeUndefined();
		expect(client.commands).toHaveLength(1);
		expect(client.commands[0]?.cwd).toBe("/workspace");
		expect(parseResult(result)).toEqual({
			paths: ["a.txt", "b.txt"],
			truncated: true,
		});
	});
});
