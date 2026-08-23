import { describe, expect, it } from "bun:test";
import { resolveAndVerifyClaudeCodeExecutable } from "./claude-code-executable";

describe("resolveAndVerifyClaudeCodeExecutable", () => {
	it("resolves the glibc Linux binary from the SDK module context and exec-verifies it", () => {
		const resolutions: { request: string; paths?: string[] }[] = [];
		const executions: { executable: string; args: string[] }[] = [];

		const executable = resolveAndVerifyClaudeCodeExecutable({
			platform: "linux",
			arch: "x64",
			resolve(request, options) {
				resolutions.push({ request, paths: options?.paths });
				if (request === "@anthropic-ai/claude-agent-sdk") {
					return "/deps/sdk/sdk.mjs";
				}
				if (request === "@anthropic-ai/claude-agent-sdk-linux-x64/claude") {
					return "/deps/sdk-linux-x64/claude";
				}
				throw new Error(`unexpected resolution: ${request}`);
			},
			execFile(path, args) {
				executions.push({ executable: path, args: [...args] });
			},
		});

		expect(executable).toBe("/deps/sdk-linux-x64/claude");
		expect(resolutions).toEqual([
			{ request: "@anthropic-ai/claude-agent-sdk", paths: undefined },
			{
				request: "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
				paths: ["/deps/sdk"],
			},
		]);
		expect(resolutions.some(({ request }) => request.includes("musl"))).toBe(
			false,
		);
		expect(executions).toEqual([
			{ executable: "/deps/sdk-linux-x64/claude", args: ["--version"] },
		]);
	});

	it("selects the glibc arm64 package on Linux", () => {
		const requests: string[] = [];
		resolveAndVerifyClaudeCodeExecutable({
			platform: "linux",
			arch: "arm64",
			resolve(request) {
				requests.push(request);
				return request === "@anthropic-ai/claude-agent-sdk"
					? "/deps/sdk/sdk.mjs"
					: "/deps/sdk-linux-arm64/claude";
			},
			execFile() {},
		});

		expect(requests).toContain(
			"@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
		);
		expect(requests.some((request) => request.includes("musl"))).toBe(false);
	});

	it("fails boot when the platform binary is missing", () => {
		expect(() =>
			resolveAndVerifyClaudeCodeExecutable({
				platform: "linux",
				arch: "x64",
				resolve(request) {
					if (request === "@anthropic-ai/claude-agent-sdk") {
						return "/deps/sdk/sdk.mjs";
					}
					throw new Error("module not found");
				},
				execFile() {
					throw new Error("must not execute");
				},
			}),
		).toThrow(/Could not resolve the Claude Code platform binary/);
	});

	it("fails boot when the resolved binary does not execute", () => {
		expect(() =>
			resolveAndVerifyClaudeCodeExecutable({
				platform: "linux",
				arch: "x64",
				resolve(request) {
					return request === "@anthropic-ai/claude-agent-sdk"
						? "/deps/sdk/sdk.mjs"
						: "/deps/sdk-linux-x64/claude";
				},
				execFile() {
					throw new Error("bad ELF interpreter");
				},
			}),
		).toThrow(/failed boot verification/);
	});
});
