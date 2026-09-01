import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Resolve and exec-verify the SDK's native Claude Code binary before the
 * server can serve a Turn. Resolution starts from the SDK package directory
 * because the native platform packages are its optional dependencies, not
 * this server's. The package name deliberately omits `-musl`: the MicroVM
 * image is AL2023/glibc and the SDK's musl-first Linux default cannot
 * execute there.
 *
 * Trimmed duplicate of agentcore-runtime's resolver — the AgentCore Runtime
 * retires wholesale at v2 cutover (ADR-0034) and this surviving server must
 * not depend on retiring code; its DI seam and win32 branch stayed behind
 * with their only callers.
 */
export function resolveAndVerifyClaudeCodeExecutable(): string {
	const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
	const request = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`;
	let executable: string;
	try {
		executable = require.resolve(request, { paths: [dirname(sdkEntry)] });
	} catch (cause) {
		throw new Error(
			`Could not resolve the Claude Code platform binary: ${request}`,
			{ cause },
		);
	}
	execFileSync(executable, ["--version"], { stdio: "ignore" });
	return executable;
}
