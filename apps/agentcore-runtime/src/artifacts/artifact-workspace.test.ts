import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARTIFACT_ROOT,
	type ArtifactCommandHandle,
	type ArtifactSandbox,
	createE2bArtifactWorkspace,
} from "./artifact-workspace";

interface LocalRunOptions {
	background?: boolean;
	envs?: Record<string, string>;
	onStderr?: (data: string) => void | Promise<void>;
	onStdout?: (data: string) => void | Promise<void>;
}

function manifestSandbox(stdout: string): ArtifactSandbox {
	return {
		commands: {
			async run() {
				return { exitCode: 0, stdout, stderr: "" };
			},
		} as unknown as ArtifactSandbox["commands"],
		files: {
			async read() {
				return new ReadableStream();
			},
		},
	};
}

function localManifestSandbox(root: string): ArtifactSandbox {
	let pinnedPath: string | null = null;
	const run = async (command: string, options?: LocalRunOptions) => {
		const env = {
			...globalThis.process.env,
			...options?.envs,
			MYMEMO_ARTIFACT_ROOT: root,
		};
		if (options?.background) {
			pinnedPath = options.envs?.MYMEMO_ARTIFACT_PATH ?? null;
			const process = Bun.spawn(["bash", "-lc", command], {
				env,
				stdin: "pipe",
				stderr: "pipe",
				stdout: "pipe",
			});
			const stdout = consumeText(process.stdout, options.onStdout);
			const stderr = consumeText(process.stderr, options.onStderr);
			const result = (async () => ({
				exitCode: await process.exited,
				stdout: await stdout,
				stderr: await stderr,
			}))();
			return {
				pid: process.pid,
				wait: () => result,
				async kill() {
					process.kill();
					await process.exited;
					return true;
				},
			} satisfies ArtifactCommandHandle;
		}
		const process = Bun.spawn(["bash", "-lc", command], {
			env,
			stderr: "pipe",
			stdout: "pipe",
		});
		const stdout = new Response(process.stdout).text();
		const stderr = new Response(process.stderr).text();
		return {
			exitCode: await process.exited,
			stdout: await stdout,
			stderr: await stderr,
		};
	};
	return {
		commands: {
			run: run as ArtifactSandbox["commands"]["run"],
		},
		files: {
			async read(path) {
				if (!/^\/proc\/\d+\/fd\/3$/.test(path) || pinnedPath === null) {
					throw new Error("unexpected pinned-file path");
				}
				return Bun.file(join(root, pinnedPath)).stream();
			},
		},
	};
}

async function consumeText(
	stream: ReadableStream<Uint8Array>,
	onData?: (data: string) => void | Promise<void>,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		const text = decoder.decode(result.value, { stream: true });
		output += text;
		await onData?.(text);
	}
	const tail = decoder.decode();
	output += tail;
	if (tail) await onData?.(tail);
	return output;
}

describe("E2B Downloadable artifact workspace", () => {
	it("captures path, byte size, and modification timestamp under the reserved root", async () => {
		const calls: Array<{
			command: string;
			envs?: Record<string, string>;
		}> = [];
		const sandbox: ArtifactSandbox = {
			commands: {
				async run(command, options) {
					calls.push({ command, envs: options?.envs });
					return {
						exitCode: 0,
						stdout: JSON.stringify([
							{
								path: "nested/report.txt",
								sizeBytes: 12,
								modifiedAt: "1784112345000000000",
							},
						]),
						stderr: "",
					};
				},
			} as ArtifactSandbox["commands"],
			files: {
				async read() {
					return new ReadableStream();
				},
			},
		};
		const workspace = createE2bArtifactWorkspace(sandbox);

		expect(
			await workspace.captureManifest(new AbortController().signal),
		).toEqual([
			{
				path: "nested/report.txt",
				sizeBytes: 12,
				modifiedAt: "1784112345000000000",
			},
		]);
		expect(calls[0]?.envs?.MYMEMO_ARTIFACT_ROOT).toBe(ARTIFACT_ROOT);
		expect(calls[0]?.command).toContain("python3");
	});

	it("rejects paths that are not normalized, valid UTF-8, and within the byte limit", async () => {
		const invalidPaths = [
			"",
			"/absolute.txt",
			"../escape.txt",
			"nested/./report.txt",
			"nested//report.txt",
			"nested/../report.txt",
			"control\u0001.txt",
			"invalid-\ud800.txt",
			`${"é".repeat(512)}a`,
		];

		for (const path of invalidPaths) {
			const workspace = createE2bArtifactWorkspace(
				manifestSandbox(
					JSON.stringify([
						{ path, sizeBytes: 1, modifiedAt: "1784112345000000000" },
					]),
				),
			);

			await expect(
				workspace.captureManifest(new AbortController().signal),
			).rejects.toThrow();
		}
	});

	it("preserves nested case-sensitive paths up to 1,024 UTF-8 bytes", async () => {
		const maxPath = [
			...Array.from({ length: 5 }, () => "é".repeat(100)),
			"a".repeat(19),
		].join("/");
		expect(new TextEncoder().encode(maxPath).byteLength).toBe(1_024);
		const workspace = createE2bArtifactWorkspace(
			manifestSandbox(
				JSON.stringify([
					{ path: maxPath, sizeBytes: 1, modifiedAt: "1" },
					{ path: "nested/A.txt", sizeBytes: 2, modifiedAt: "2" },
					{ path: "nested/a.txt", sizeBytes: 3, modifiedAt: "3" },
				]),
			),
		);

		expect(
			(await workspace.captureManifest(new AbortController().signal)).map(
				(entry) => entry.path,
			),
		).toEqual([maxPath, "nested/A.txt", "nested/a.txt"]);
	});

	it("fails the complete manifest for symlinks and special files", async () => {
		const root = await mkdtemp(join(tmpdir(), "mymemo-artifacts-"));
		const outside = await mkdtemp(join(tmpdir(), "mymemo-outside-"));
		try {
			await mkdir(join(root, "nested"));
			await writeFile(join(root, "safe.txt"), "safe");
			await writeFile(join(outside, "secret.txt"), "secret");
			await symlink(
				join(outside, "secret.txt"),
				join(root, "nested", "escape.txt"),
			);

			const workspace = createE2bArtifactWorkspace(localManifestSandbox(root));
			await expect(
				workspace.captureManifest(new AbortController().signal),
			).rejects.toThrow();

			await rm(join(root, "nested", "escape.txt"));
			const fifoPath = join(root, "named-pipe");
			const fifo = Bun.spawn(["mkfifo", fifoPath]);
			expect(await fifo.exited).toBe(0);
			await expect(
				workspace.captureManifest(new AbortController().signal),
			).rejects.toThrow();
			await rm(fifoPath);
		} finally {
			await rm(root, { force: true, recursive: true });
			await rm(outside, { force: true, recursive: true });
		}
	});

	it("rejects a file swapped to an outside-root symlink after the manifest", async () => {
		const root = await mkdtemp(join(tmpdir(), "mymemo-artifacts-"));
		const outside = await mkdtemp(join(tmpdir(), "mymemo-outside-"));
		try {
			await mkdir(join(root, "nested"));
			await writeFile(join(root, "nested", "report.txt"), "inside");
			await writeFile(join(outside, "secret.txt"), "secret");
			const workspace = createE2bArtifactWorkspace(localManifestSandbox(root));
			const [entry] = await workspace.captureManifest(
				new AbortController().signal,
			);
			if (!entry) throw new Error("expected artifact manifest entry");

			await rm(join(root, "nested", "report.txt"));
			await symlink(
				join(outside, "secret.txt"),
				join(root, "nested", "report.txt"),
			);

			await expect(
				workspace.openFile(entry, new AbortController().signal),
			).rejects.toMatchObject({ code: "special_entry" });
		} finally {
			await rm(root, { force: true, recursive: true });
			await rm(outside, { force: true, recursive: true });
		}
	});

	it("opens binary files as streams without decoding them", async () => {
		const root = await mkdtemp(join(tmpdir(), "mymemo-artifacts-"));
		try {
			await mkdir(join(root, "images"));
			await writeFile(
				join(root, "images", "chart.bin"),
				new Uint8Array([0, 255, 1]),
			);
			const workspace = createE2bArtifactWorkspace(localManifestSandbox(root));
			const [entry] = await workspace.captureManifest(
				new AbortController().signal,
			);
			if (!entry) throw new Error("expected artifact manifest entry");
			const stream = await workspace.openFile(
				entry,
				new AbortController().signal,
			);

			expect([
				...new Uint8Array(await new Response(stream).arrayBuffer()),
			]).toEqual([0, 255, 1]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
