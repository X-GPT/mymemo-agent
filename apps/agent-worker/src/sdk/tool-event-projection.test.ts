import { describe, expect, it } from "bun:test";
import {
	isToolResultPayload,
	isToolUsePayload,
} from "@mymemo/agent-db/run-events";
import {
	allowlistedExecutorToolNames,
	fitOrOmit,
	projectToolResult,
	projectToolUse,
	publicToolName,
	TOOL_EVENT_MAX_JSON_BYTES,
} from "./tool-event-projection";

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The canonical MCP content the executor Bash tool returns on success. */
function bashResultContent(result: Record<string, unknown>): unknown {
	return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

function completedBashResult(overrides: Record<string, unknown> = {}) {
	return {
		exitCode: 0,
		stdout: "hello\n",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
		outcome: "completed",
		...overrides,
	};
}

describe("publicToolName", () => {
	it("maps every allowlisted executor tool name to its public name", () => {
		expect(publicToolName("mcp__mymemo-executor__Bash")).toBe("Bash");
		expect(publicToolName("mcp__mymemo-executor__Read")).toBe("Read");
		expect(publicToolName("mcp__mymemo-executor__Write")).toBe("Write");
		expect(publicToolName("mcp__mymemo-executor__Edit")).toBe("Edit");
		expect(publicToolName("mcp__mymemo-executor__Grep")).toBe("Grep");
		expect(publicToolName("mcp__mymemo-executor__Glob")).toBe("Glob");
		expect(publicToolName("mcp__mymemo-executor__SearchDocuments")).toBe(
			"SearchDocuments",
		);
		expect(publicToolName("mcp__mymemo-executor__LoadDocuments")).toBe(
			"LoadDocuments",
		);
	});

	it("fails closed on names outside the allowlist", () => {
		// A built-in or bare short name is not an executor tool name.
		expect(publicToolName("Bash")).toBeNull();
		// Another server's prefixed tool must never become client-visible.
		expect(publicToolName("mcp__other-server__Bash")).toBeNull();
		expect(publicToolName("WebSearch")).toBeNull();
		expect(publicToolName("")).toBeNull();
		expect(publicToolName(undefined)).toBeNull();
		expect(publicToolName(42)).toBeNull();
	});

	it("allowlists exactly the eight executor tool names", () => {
		expect(allowlistedExecutorToolNames().sort()).toEqual(
			[
				"mcp__mymemo-executor__Bash",
				"mcp__mymemo-executor__Edit",
				"mcp__mymemo-executor__Glob",
				"mcp__mymemo-executor__Grep",
				"mcp__mymemo-executor__LoadDocuments",
				"mcp__mymemo-executor__Read",
				"mcp__mymemo-executor__SearchDocuments",
				"mcp__mymemo-executor__Write",
			].sort(),
		);
	});
});

describe("projectToolUse — Bash", () => {
	it("exposes the command preview, cwd, and timeout", () => {
		const projected = projectToolUse("Bash", {
			command: "ls -la",
			cwd: "src",
			timeoutMs: 30_000,
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Bash",
				arguments: { command: "ls -la", cwd: "src", timeoutMs: 30_000 },
				truncated: false,
			},
		});
	});

	it("produces payloads that satisfy the shared vocabulary guard", () => {
		const projected = projectToolUse("Bash", { command: "echo hi" });
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(isToolUsePayload(projected.payload)).toBe(true);
	});

	it("omits missing or wrong-typed argument fields instead of forwarding them", () => {
		const projected = projectToolUse("Bash", {
			command: 42,
			cwd: ["src"],
			timeoutMs: "soon",
			env: { SECRET: "leak" },
		});
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.arguments).toEqual({});
	});

	it("projects a non-record input as empty arguments", () => {
		const projected = projectToolUse("Bash", "rm -rf /");
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.arguments).toEqual({});
		expect(projected.payload.truncated).toBe(false);
	});

	it("caps a huge command to a bounded preview and flags truncation", () => {
		const projected = projectToolUse("Bash", {
			command: "x".repeat(100_000),
			cwd: "deep/".repeat(1_000),
			timeoutMs: 5_000,
		});
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		const command = projected.payload.arguments.command;
		expect(typeof command).toBe("string");
		expect((command as string).length).toBeLessThan(100_000);
		expect((command as string).startsWith("xxx")).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("stays within the event cap even when every character escapes", () => {
		// Control characters serialize as \u00XX — six JSON bytes per input char.
		const projected = projectToolUse("Bash", {
			command: "\u0001".repeat(100_000),
		});
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.truncated).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("fails closed for executor tools without an argument projection yet", () => {
		for (const tool of [
			"Read",
			"Write",
			"Edit",
			"Grep",
			"Glob",
			"SearchDocuments",
			"LoadDocuments",
		] as const) {
			const projected = projectToolUse(tool, { path: "file.txt" });
			expect(projected.ok).toBe(false);
		}
	});
});

describe("projectToolResult — Bash", () => {
	it("re-projects the executor result field by field", () => {
		const projected = projectToolResult(
			"Bash",
			bashResultContent(completedBashResult()),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Bash",
				result: {
					exitCode: 0,
					stdout: "hello\n",
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					outcome: "completed",
				},
				isError: false,
				truncated: false,
			},
		});
	});

	it("produces payloads that satisfy the shared vocabulary guard", () => {
		const projected = projectToolResult(
			"Bash",
			bashResultContent(completedBashResult()),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(isToolResultPayload(projected.payload)).toBe(true);
	});

	it("projects a nonzero exit as a returned result, not a tool error", () => {
		const projected = projectToolResult(
			"Bash",
			bashResultContent(
				completedBashResult({ exitCode: 2, stderr: "not found\n" }),
			),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.isError).toBe(false);
		expect(projected.payload.result.exitCode).toBe(2);
		expect(projected.payload.result.stderr).toBe("not found\n");
	});

	it("preserves a null exit code from a killed command", () => {
		const projected = projectToolResult(
			"Bash",
			bashResultContent(
				completedBashResult({ exitCode: null, outcome: "timeout" }),
			),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.exitCode).toBeNull();
		expect(projected.payload.result.outcome).toBe("timeout");
	});

	it("caps huge stdout/stderr previews and flags truncation", () => {
		const projected = projectToolResult(
			"Bash",
			bashResultContent(
				completedBashResult({
					stdout: "a".repeat(60_000),
					stderr: "b".repeat(60_000),
				}),
			),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		expect(projected.payload.result.stdoutTruncated).toBe(true);
		expect(projected.payload.result.stderrTruncated).toBe(true);
		expect((projected.payload.result.stdout as string).length).toBeLessThan(
			60_000,
		);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("keeps the executor's own truncation flags when the preview fits", () => {
		const projected = projectToolResult(
			"Bash",
			bashResultContent(
				completedBashResult({ stdout: "prefix", stdoutTruncated: true }),
			),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.stdoutTruncated).toBe(true);
		// The event itself was not clipped by projection.
		expect(projected.payload.truncated).toBe(false);
	});

	it("accepts plain string content as the executor text", () => {
		const projected = projectToolResult(
			"Bash",
			JSON.stringify(completedBashResult()),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.stdout).toBe("hello\n");
	});

	it("omits results whose text is not the known executor shape", () => {
		expect(
			projectToolResult("Bash", [{ type: "text", text: "not json" }], false).ok,
		).toBe(false);
		expect(
			projectToolResult("Bash", bashResultContent({ exitCode: "zero" }), false)
				.ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Bash",
				bashResultContent(completedBashResult({ stdout: 42 })),
				false,
			).ok,
		).toBe(false);
		expect(projectToolResult("Bash", [], false).ok).toBe(false);
		expect(projectToolResult("Bash", undefined, false).ok).toBe(false);
		expect(
			projectToolResult("Bash", [{ type: "image", data: "..." }], false).ok,
		).toBe(false);
	});

	it("projects every error-flagged result as the fixed safe message", () => {
		const projected = projectToolResult(
			"Bash",
			[{ type: "text", text: "ECONNREFUSED 10.0.0.7:5432 at /srv/db.ts:42" }],
			true,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Bash",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			},
		});
	});

	it("never parses content on the error path, whatever its shape", () => {
		for (const content of [
			undefined,
			"raw failure text",
			[{ type: "text", text: "x".repeat(200_000) }],
			[{ type: "image", data: "!" }],
		]) {
			const projected = projectToolResult("Read", content, true);
			expect(projected).toEqual({
				ok: true,
				payload: {
					tool: "Read",
					result: { message: "Tool failed" },
					isError: true,
					truncated: false,
				},
			});
		}
	});

	it("fails closed for executor tools without a result projection yet", () => {
		const projected = projectToolResult(
			"Read",
			[{ type: "text", text: JSON.stringify({ preview: "..." }) }],
			false,
		);
		expect(projected.ok).toBe(false);
	});
});

describe("fitOrOmit", () => {
	// Bash's per-field budgets keep every capped payload under the event cap,
	// so the never-split-or-omit backstop is pinned directly: a payload that
	// still cannot fit is omitted with a reason, never appended oversize.
	it("omits a payload whose capped form still exceeds the event cap", () => {
		const oversize = fitOrOmit({
			tool: "Bash",
			arguments: { command: "x".repeat(TOOL_EVENT_MAX_JSON_BYTES) },
			truncated: true,
		});
		expect(oversize).toEqual({
			ok: false,
			reason: "tool event exceeds the size cap after projection",
		});
	});

	it("passes a payload that serializes exactly at the cap", () => {
		const skeleton = {
			tool: "Bash",
			arguments: { command: "" },
			truncated: false,
		};
		const overhead = Buffer.byteLength(JSON.stringify(skeleton), "utf8");
		const payload = {
			...skeleton,
			arguments: { command: "x".repeat(TOOL_EVENT_MAX_JSON_BYTES - overhead) },
		};
		expect(fitOrOmit(payload)).toEqual({ ok: true, payload });
	});
});
