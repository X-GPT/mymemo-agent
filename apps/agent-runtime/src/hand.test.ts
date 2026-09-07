import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { bounded, createHand, type HandInvoke, workspacePath } from "./hand";

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("claude-agent-sdk"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = sdkRequire(
	"@modelcontextprotocol/sdk/inMemory.js",
);

async function harness(invoke: HandInvoke, fatal = (_error: Error) => {}) {
	const server = createHand(invoke, fatal);
	const client = new Client({ name: "test", version: "1" });
	const [left, right] = InMemoryTransport.createLinkedPair();
	await server.instance.connect(left);
	await client.connect(right);
	return {
		async call(name: string, args: object) {
			const result = await client.callTool({ name, arguments: args });
			return {
				error: !!result.isError,
				output: result.content[0].text.startsWith("{")
					? JSON.parse(result.content[0].text)
					: { value: result.content[0].text },
			};
		},
		close: () => client.close(),
	};
}

test("Hand confines paths and caps Unicode by bytes", () => {
	for (const path of [
		"../secret",
		"/tmp/secret",
		"/ws/../secret",
		"/ws/a/../../secret",
		"a\0b",
	])
		expect(() => workspacePath(path)).toThrow();
	expect(workspacePath("/ws/a.txt")).toBe("ws/a.txt");
	expect(workspacePath("a.txt")).toBe("ws/a.txt");
	const out = bounded("😀".repeat(20000));
	expect(Buffer.byteLength(out.value)).toBeLessThanOrEqual(65536);
	expect(out.truncated).toBe(true);
	expect(out.totalBytes).toBe(80000);
});

test("Hand executes real shell and file operations only through its sandbox transport", async () => {
	const home = await mkdtemp(join(tmpdir(), "hand-test-"));
	await mkdir(join(home, "ws"));
	const h = await harness(async (name, args) => {
		if (name === "executeCommand") {
			const { stdout, stderr } = await promisify(execFile)(
				"sh",
				["-c", args.command ?? ""],
				{ cwd: home, env: { ...process.env, HOME: home } },
			);
			return {
				content: [],
				structuredContent: { stdout, stderr, exitCode: 0 },
			};
		}
		if (name === "readFiles")
			return {
				content: [
					{
						type: "resource",
						resource: {
							type: "text",
							text: await readFile(join(home, args.paths?.[0] ?? ""), "utf8"),
						},
					},
				],
			};
		if (name === "writeFiles") {
			const file = args.content?.[0];
			await writeFile(join(home, file?.path ?? ""), file?.text ?? "");
			return { content: [] };
		}
		throw new Error(`Unexpected ${name}`);
	});
	try {
		expect(
			(
				await h.call("write", {
					file_path: "/ws/sub/notes.txt",
					content: "one\ntwo\nthree",
				})
			).error,
		).toBe(false);
		expect(
			(
				await h.call("read", {
					file_path: "/ws/sub/notes.txt",
					offset: 2,
					limit: 1,
				})
			).output.value,
		).toBe("two\n");
		expect(
			(
				await h.call("edit", {
					file_path: "/ws/sub/notes.txt",
					old_string: "two",
					new_string: "changed",
				})
			).error,
		).toBe(false);
		expect(
			(
				await h.call("edit", {
					file_path: "/ws/sub/notes.txt",
					old_string: "e",
					new_string: "X",
				})
			).error,
		).toBe(true);
		expect(
			(await h.call("bash", { command: "cat sub/notes.txt" })).output.value,
		).toContain("changed");
		expect((await h.call("glob", { pattern: "*.txt" })).output.value).toContain(
			"notes.txt",
		);
		await h.call("write", { file_path: "/ws/root.txt", content: "root" });
		expect(
			(await h.call("glob", { pattern: "**/*.txt" })).output.value,
		).toContain("root.txt");
		expect(
			(await h.call("grep", { pattern: "changed", output_mode: "content" }))
				.output.value,
		).toContain("changed");
		await writeFile(
			join(home, "ws", "large.txt"),
			"x".repeat(36 * 1024 * 1024),
		);
		const large = await h.call("read", { file_path: "/ws/large.txt" });
		expect(large.error).toBe(false);
		expect(large.output.value.length).toBe(65536);
		expect(large.output.truncated).toBe(true);
		await writeFile(join(home, "ws", "binary.bin"), Buffer.from([0, 255]));
		expect(
			(await h.call("read", { file_path: "/ws/binary.bin" })).output.value,
		).toContain('"sizeBytes": 2');
		const cap = await h.call("bash", {
			command: "python3 -c 'print(\"x\"*100000)'",
		});
		expect(cap.output.totalBytes).toBe(100001);
		expect(cap.output.value.length).toBe(65536);
		expect(cap.output.truncated).toBe(true);
		expect(
			(await h.call("bash", { command: "sleep 3", timeout: 10 })).error,
		).toBe(true);
		await h.call("bash", { command: "ln -s /tmp escape" });
		expect(
			(await h.call("read", { file_path: "/ws/escape/secret" })).error,
		).toBe(true);
		expect(
			(
				await h.call("write", {
					file_path: "/ws/huge",
					content: "x".repeat(1048577),
				})
			).error,
		).toBe(true);
		expect(
			(await h.call("bash", { command: "true", run_in_background: true }))
				.error,
		).toBe(true);
	} finally {
		await h.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("Dead sandbox reports fatal loss; ordinary errors remain tool errors", async () => {
	for (const error of [
		Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }),
		new Error("session is not active"),
		new Error("ordinary failure"),
	]) {
		let fatal = false;
		const h = await harness(
			async () => {
				throw error;
			},
			() => {
				fatal = true;
			},
		);
		try {
			expect((await h.call("bash", { command: "true" })).error).toBe(true);
			expect(fatal).toBe(error.message !== "ordinary failure");
		} finally {
			await h.close();
		}
	}
});
