import { describe, expect, it } from "bun:test";
import { CommandExitError } from "e2b";
import { E2BFileClient, type FileSandbox } from "./file-client";

type RunCall = { cmd: string; opts?: { cwd?: string; timeoutMs?: number } };

function makeFakeSandbox(options: {
	fileBytes?: Uint8Array;
	runCommand?: (call: RunCall) => Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}>;
}): {
	sandbox: FileSandbox;
	reads: string[];
	writes: { path: string; data: string }[];
	runs: RunCall[];
} {
	const reads: string[] = [];
	const writes: { path: string; data: string }[] = [];
	const runs: RunCall[] = [];
	return {
		reads,
		writes,
		runs,
		sandbox: {
			files: {
				read: async (path, _opts) => {
					reads.push(path);
					return options.fileBytes ?? new Uint8Array();
				},
				write: async (path, data) => {
					writes.push({ path, data });
					return {};
				},
			},
			commands: {
				run: async (cmd, opts) => {
					const call = { cmd, opts };
					runs.push(call);
					if (!options.runCommand) throw new Error("unexpected command");
					return options.runCommand(call);
				},
			},
		},
	};
}

describe("E2BFileClient", () => {
	it("reads file content capped at maxBytes", async () => {
		const { sandbox, reads } = makeFakeSandbox({
			fileBytes: new TextEncoder().encode("alpha beta"),
		});
		const client = new E2BFileClient(sandbox);

		const content = await client.readFile({
			path: "/home/user/notes.txt",
			maxBytes: 5,
		});

		expect(content).toBe("alpha");
		expect(reads).toEqual(["/home/user/notes.txt"]);
	});

	it("writes file content at the given path", async () => {
		const { sandbox, writes } = makeFakeSandbox({});
		const client = new E2BFileClient(sandbox);

		await client.writeFile({ path: "/home/user/out.txt", content: "hello" });

		expect(writes).toEqual([{ path: "/home/user/out.txt", data: "hello" }]);
	});

	it("runs a command with cwd and timeout, bounding stdout to maxOutputBytes", async () => {
		const { sandbox, runs } = makeFakeSandbox({
			runCommand: async () => ({
				exitCode: 0,
				stdout: "abcdefgh",
				stderr: "",
			}),
		});
		const client = new E2BFileClient(sandbox);

		const result = await client.runCommand({
			command: "rg alpha",
			cwd: "/home/user",
			timeoutMs: 10_000,
			maxOutputBytes: 4,
		});

		expect(runs).toEqual([
			{ cmd: "rg alpha", opts: { cwd: "/home/user", timeoutMs: 10_000 } },
		]);
		expect(result).toEqual({
			exitCode: 0,
			stdout: "abcd",
			stderr: "",
			truncated: true,
		});
	});

	it("returns a non-zero exit as a result, not a throw (rg exits 1 on no matches)", async () => {
		const { sandbox } = makeFakeSandbox({
			runCommand: async () => {
				throw new CommandExitError({ exitCode: 1, stdout: "", stderr: "" });
			},
		});
		const client = new E2BFileClient(sandbox);

		const result = await client.runCommand({
			command: "rg missing",
			cwd: "/home/user",
			timeoutMs: 10_000,
			maxOutputBytes: 1024,
		});

		expect(result).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: "",
			truncated: false,
		});
	});

	it("propagates non-exit command failures", async () => {
		const { sandbox } = makeFakeSandbox({
			runCommand: async () => {
				throw new Error("connection lost");
			},
		});
		const client = new E2BFileClient(sandbox);

		await expect(
			client.runCommand({
				command: "rg alpha",
				cwd: "/home/user",
				timeoutMs: 10_000,
				maxOutputBytes: 1024,
			}),
		).rejects.toThrow("connection lost");
	});
});
