import { describe, expect, it } from "bun:test";
import { resolveAndVerifyClaudeCodeExecutable } from "./claude-code-executable";

describe("resolveAndVerifyClaudeCodeExecutable", () => {
	// Real resolution + exec against the workspace SDK install — the property
	// the VM boot depends on. The missing/non-executable branches are proven
	// live: a failed exec-verify fails the /run hook, and smoke.sh's
	// cli-binary check asserts the ELF in-image.
	it("resolves and exec-verifies the SDK's glibc platform binary", () => {
		const executable = resolveAndVerifyClaudeCodeExecutable();
		expect(executable).toContain(
			`claude-agent-sdk-${process.platform}-${process.arch}`,
		);
		expect(executable).not.toContain("musl");
	});
});
