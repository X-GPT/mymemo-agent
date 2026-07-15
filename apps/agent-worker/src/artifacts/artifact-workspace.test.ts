import { describe, expect, it } from "bun:test";
import {
	ARTIFACT_ROOT,
	type ArtifactSandbox,
	createE2bArtifactWorkspace,
} from "./artifact-workspace";

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
			},
			files: {
				async read() {
					return new Uint8Array();
				},
				async write() {},
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

	it("reads binary bytes without decoding them", async () => {
		const reads: string[] = [];
		const sandbox: ArtifactSandbox = {
			commands: {
				async run() {
					return { exitCode: 0, stdout: "[]", stderr: "" };
				},
			},
			files: {
				async read(path) {
					reads.push(path);
					return new Uint8Array([0, 255, 1]);
				},
				async write() {},
			},
		};
		const workspace = createE2bArtifactWorkspace(sandbox);

		expect([
			...(await workspace.readFile(
				"images/chart.bin",
				new AbortController().signal,
			)),
		]).toEqual([0, 255, 1]);
		expect(reads).toEqual([`${ARTIFACT_ROOT}/images/chart.bin`]);
	});
});
