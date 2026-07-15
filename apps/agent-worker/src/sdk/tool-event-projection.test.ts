import { describe, expect, it } from "bun:test";
import {
	isToolResultPayload,
	isToolUsePayload,
	type PublicToolName,
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

/** The canonical MCP content every executor tool returns on success. */
function executorResultContent(result: Record<string, unknown>): unknown {
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
		expect(publicToolName("mcp__mymemo-executor__ListDocuments")).toBe(
			"ListDocuments",
		);
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
		// Inherited object properties are not allowlisted tool names.
		expect(publicToolName("constructor")).toBeNull();
		expect(publicToolName("")).toBeNull();
		expect(publicToolName(undefined)).toBeNull();
		expect(publicToolName(42)).toBeNull();
	});

	it("allowlists exactly the nine executor tool names", () => {
		expect(allowlistedExecutorToolNames().sort()).toEqual(
			[
				"mcp__mymemo-executor__Bash",
				"mcp__mymemo-executor__Edit",
				"mcp__mymemo-executor__Glob",
				"mcp__mymemo-executor__Grep",
				"mcp__mymemo-executor__LoadDocuments",
				"mcp__mymemo-executor__ListDocuments",
				"mcp__mymemo-executor__Read",
				"mcp__mymemo-executor__SearchDocuments",
				"mcp__mymemo-executor__Write",
			].sort(),
		);
	});
});

describe("shared tool payload vocabulary", () => {
	const toolUseCases = [
		["Bash", { command: "echo hi" }],
		["Read", { path: "notes.md" }],
		["Write", { path: "notes.md", content: "x" }],
		["Edit", { path: "src/app.ts", oldText: "a", newText: "b" }],
		["Grep", { pattern: "x" }],
		["Glob", { pattern: "*" }],
	] satisfies ReadonlyArray<readonly [PublicToolName, unknown]>;

	for (const [tool, input] of toolUseCases) {
		it(`${tool} tool-use projection satisfies the shared guard`, () => {
			const projected = projectToolUse(tool, input);
			if (!projected.ok) throw new Error("expected a projected payload");
			expect(isToolUsePayload(projected.payload)).toBe(true);
		});
	}

	const toolResultCases = [
		["Bash", completedBashResult()],
		["Write", { path: "notes.md", bytesWritten: 42 }],
		["Edit", { path: "src/app.ts", replacements: 1 }],
		[
			"Read",
			{
				path: "src/index.ts",
				content: "line one\nline two",
				startLine: 1,
				linesRead: 2,
				truncated: false,
			},
		],
		[
			"Grep",
			{
				matches: [
					{
						path: "src/app.ts",
						line: 12,
						column: 3,
						text: "// TODO: fix",
					},
				],
				truncated: false,
			},
		],
		["Glob", { paths: ["a.ts"], truncated: false }],
	] satisfies ReadonlyArray<readonly [PublicToolName, Record<string, unknown>]>;

	for (const [tool, result] of toolResultCases) {
		it(`${tool} tool-result projection satisfies the shared guard`, () => {
			const projected = projectToolResult(
				tool,
				executorResultContent(result),
				false,
			);
			if (!projected.ok) throw new Error("expected a projected payload");
			expect(isToolResultPayload(projected.payload)).toBe(true);
		});
	}
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

	it("omits invocations with missing or wrong-typed required arguments", () => {
		for (const input of [{}, { command: 42 }]) {
			expect(projectToolUse("Bash", input).ok).toBe(false);
		}
	});

	it("omits a non-record input", () => {
		expect(projectToolUse("Bash", "rm -rf /").ok).toBe(false);
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
});

describe("projectToolUse — Read", () => {
	it("exposes the path and line window", () => {
		const projected = projectToolUse("Read", {
			path: "src/index.ts",
			offset: 10,
			limit: 50,
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Read",
				arguments: { path: "src/index.ts", offset: 10, limit: 50 },
				truncated: false,
			},
		});
	});

	it("omits invocations with missing or wrong-typed required arguments", () => {
		for (const input of [{}, { path: 42 }]) {
			expect(projectToolUse("Read", input).ok).toBe(false);
		}
	});

	it("caps a huge path to a bounded preview and flags truncation", () => {
		const projected = projectToolUse("Read", {
			path: `${"deep/".repeat(20_000)}file.ts`,
		});
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		expect((projected.payload.arguments.path as string).length).toBeLessThan(
			100_000,
		);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});
});

describe("projectToolUse — SearchDocuments", () => {
	it("exposes only the query preview", () => {
		const projected = projectToolUse("SearchDocuments", {
			query: "quarterly roadmap",
			maxResults: 8,
			scope: { type: "collection", collectionId: "collection-secret" },
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "SearchDocuments",
				arguments: { query: "quarterly roadmap" },
				truncated: false,
			},
		});
	});

	it("omits malformed inputs instead of persisting empty arguments", () => {
		for (const input of [undefined, "query", {}, { query: 42 }]) {
			expect(projectToolUse("SearchDocuments", input).ok).toBe(false);
		}
	});

	it("caps an oversized query into one guard-valid event", () => {
		const projected = projectToolUse("SearchDocuments", {
			query: "\u0001".repeat(100_000),
		});

		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.truncated).toBe(true);
		expect(isToolUsePayload(projected.payload)).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});
});

describe("projectToolUse — ListDocuments", () => {
	it("exposes the limit and cursor presence without exposing the cursor", () => {
		const projected = projectToolUse("ListDocuments", {
			limit: 20,
			cursor: "pagination-secret",
			scope: { type: "collection", collectionId: "scope-secret" },
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "ListDocuments",
				arguments: { limit: 20, cursorProvided: true },
				truncated: false,
			},
		});
	});
});

describe("projectToolUse — LoadDocuments", () => {
	it("exposes only the requested document count", () => {
		const projected = projectToolUse("LoadDocuments", {
			documentIds: ["document-secret-1", "document-secret-2"],
			scope: { type: "document", summaryId: "scope-secret" },
			cachePath: ".mymemo/docs/document-secret-1.md",
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "LoadDocuments",
				arguments: { requestedCount: 2 },
				truncated: false,
			},
		});
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(isToolUsePayload(projected.payload)).toBe(true);
	});

	it("omits malformed inputs instead of counting arbitrary array members", () => {
		for (const input of [
			undefined,
			["document-secret"],
			{},
			{ documentIds: "document-secret" },
			{ documentIds: ["document-secret", 42] },
		]) {
			expect(projectToolUse("LoadDocuments", input).ok).toBe(false);
		}
	});
});

describe("projectToolResult — Bash", () => {
	it("re-projects the executor result field by field", () => {
		const projected = projectToolResult(
			"Bash",
			executorResultContent(completedBashResult()),
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

	it("projects a nonzero exit as a returned result, not a tool error", () => {
		const projected = projectToolResult(
			"Bash",
			executorResultContent(
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
			executorResultContent(
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
			executorResultContent(
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
			executorResultContent(
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
			projectToolResult(
				"Bash",
				executorResultContent({ exitCode: "zero" }),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Bash",
				executorResultContent(completedBashResult({ stdout: 42 })),
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
});

describe("projectToolResult — SearchDocuments", () => {
	it("exposes only bounded title and snippet previews", () => {
		const projected = projectToolResult(
			"SearchDocuments",
			executorResultContent({
				passages: [
					{
						passageId: "passage-secret",
						documentId: "document-secret",
						title: "Roadmap",
						snippet: "Ship the durable tool timeline.",
						scope: { type: "collection", collectionId: "scope-secret" },
					},
				],
				policy: { decision: "allow", rule: "internal-only" },
			}),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "SearchDocuments",
				result: {
					passages: [
						{
							title: "Roadmap",
							snippet: "Ship the durable tool timeline.",
						},
					],
				},
				isError: false,
				truncated: false,
			},
		});
	});

	it("projects a no-hit result without inheriting its internal message", () => {
		const projected = projectToolResult(
			"SearchDocuments",
			executorResultContent({
				passages: [],
				message: "No MyMemo document passages matched the query.",
				audit: { scope: "collection-secret", policy: "allow" },
			}),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "SearchDocuments",
				result: { passages: [] },
				isError: false,
				truncated: false,
			},
		});
	});

	it("bounds the passage list and previews within one guard-valid event", () => {
		const projected = projectToolResult(
			"SearchDocuments",
			executorResultContent({
				passages: Array.from({ length: 20 }, (_, index) => ({
					passageId: `passage-${index}`,
					documentId: `document-${index}`,
					title: `Title ${index} ${"t".repeat(10_000)}`,
					snippet: `Snippet ${index} ${"s".repeat(20_000)}`,
				})),
			}),
			false,
		);

		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.passages).toHaveLength(5);
		expect(projected.payload.truncated).toBe(true);
		expect(isToolResultPayload(projected.payload)).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});
});

describe("projectToolResult — ListDocuments", () => {
	it("exposes counts, page state, and bounded titles without identifiers or cursors", () => {
		const projected = projectToolResult(
			"ListDocuments",
			executorResultContent({
				total: 42,
				documents: [
					{
						documentId: "document-secret",
						title: "Roadmap",
						sourceType: "google_drive",
						language: "en",
						createdAt: "2026-07-15T00:00:00.000Z",
					},
				],
				nextCursor: "cursor-secret",
			}),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "ListDocuments",
				result: {
					total: 42,
					returnedCount: 1,
					hasMore: true,
					documents: [{ title: "Roadmap" }],
				},
				isError: false,
				truncated: false,
			},
		});
	});

	it("bounds title previews and the list within one guard-valid event", () => {
		const projected = projectToolResult(
			"ListDocuments",
			executorResultContent({
				total: 30,
				documents: Array.from({ length: 30 }, (_, index) => ({
					documentId: `document-secret-${index}`,
					title: `Title ${index} ${"t".repeat(10_000)}`,
					sourceType: "upload",
					language: null,
					createdAt: "2026-07-15T00:00:00.000Z",
				})),
				nextCursor: null,
			}),
			false,
		);

		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.returnedCount).toBe(30);
		expect(projected.payload.result.documents).toHaveLength(10);
		expect(projected.payload.result.hasMore).toBe(false);
		expect(projected.payload.truncated).toBe(true);
		expect(isToolResultPayload(projected.payload)).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("omits malformed inventory results", () => {
		for (const result of [
			{},
			{ total: "42", documents: [], nextCursor: null },
			{ total: 42, documents: "secret", nextCursor: null },
			{ total: 42, documents: [{ title: 42 }], nextCursor: null },
			{ total: 42, documents: [], nextCursor: 42 },
		]) {
			expect(
				projectToolResult("ListDocuments", executorResultContent(result), false)
					.ok,
			).toBe(false);
		}
	});
});

describe("projectToolResult — LoadDocuments", () => {
	it("exposes bounded titles and a fixed failure count summary", () => {
		const projected = projectToolResult(
			"LoadDocuments",
			executorResultContent({
				loaded: [
					{
						documentId: "document-good-secret",
						title: "Roadmap",
						path: ".mymemo/docs/document-good-secret.md",
						truncated: false,
					},
				],
				errors: [
					{
						documentId: "document-bad-secret",
						error: "document is outside scope collection-secret",
					},
				],
			}),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "LoadDocuments",
				result: {
					loadedCount: 1,
					loaded: [{ title: "Roadmap" }],
					failedCount: 1,
					failureSummary: "Some documents could not be loaded",
				},
				isError: false,
				truncated: false,
			},
		});
	});

	it("bounds title previews and the list within one guard-valid event", () => {
		const projected = projectToolResult(
			"LoadDocuments",
			executorResultContent({
				loaded: Array.from({ length: 30 }, (_, index) => ({
					documentId: `document-secret-${index}`,
					title: `Title ${index} ${"t".repeat(10_000)}`,
					path: `.mymemo/docs/document-secret-${index}.md`,
					truncated: false,
				})),
				errors: [],
			}),
			false,
		);

		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.loadedCount).toBe(30);
		expect(projected.payload.result.loaded).toHaveLength(10);
		expect(projected.payload.truncated).toBe(true);
		expect(isToolResultPayload(projected.payload)).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("uses the fixed whole-call error shape without parsing raw text", () => {
		const projected = projectToolResult(
			"LoadDocuments",
			[
				{
					type: "text",
					text: "LoadDocuments failed for document-secret at .mymemo/docs/secret.md",
				},
			],
			true,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "LoadDocuments",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			},
		});
	});
});

describe("projectToolUse — Write", () => {
	it("exposes the path, a content preview, and the full byte count", () => {
		const projected = projectToolUse("Write", {
			path: "notes.md",
			content: "héllo wörld",
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Write",
				arguments: {
					path: "notes.md",
					content: "héllo wörld",
					// UTF-8 bytes of the full content, not its character count.
					contentBytes: 13,
				},
				truncated: false,
			},
		});
	});

	it("omits invocations with missing or wrong-typed required arguments", () => {
		for (const input of [
			{},
			{ path: 42, content: "text" },
			{ path: "notes.md", content: ["not", "text"] },
		]) {
			expect(projectToolUse("Write", input).ok).toBe(false);
		}
	});

	it("caps a huge content preview but reports the full byte count", () => {
		const projected = projectToolUse("Write", {
			path: "big.txt",
			content: "x".repeat(100_000),
		});
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		expect(projected.payload.arguments.contentBytes).toBe(100_000);
		expect((projected.payload.arguments.content as string).length).toBeLessThan(
			100_000,
		);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});
});

describe("projectToolResult — Write", () => {
	it("re-projects the executor result field by field", () => {
		const projected = projectToolResult(
			"Write",
			executorResultContent({ path: "notes.md", bytesWritten: 42 }),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Write",
				result: { path: "notes.md", bytesWritten: 42 },
				isError: false,
				truncated: false,
			},
		});
	});

	it("omits results whose text is not the known executor shape", () => {
		expect(
			projectToolResult("Write", [{ type: "text", text: "ok" }], false).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Write",
				executorResultContent({ path: "notes.md", bytesWritten: "42" }),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Write",
				executorResultContent({ bytesWritten: 42 }),
				false,
			).ok,
		).toBe(false);
	});
});

describe("projectToolUse — Edit", () => {
	it("exposes the path, both text previews, and their byte counts", () => {
		const projected = projectToolUse("Edit", {
			path: "src/app.ts",
			oldText: "const a",
			newText: "const alpha",
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Edit",
				arguments: {
					path: "src/app.ts",
					oldText: "const a",
					oldTextBytes: 7,
					newText: "const alpha",
					newTextBytes: 11,
				},
				truncated: false,
			},
		});
	});

	it("omits invocations with missing or wrong-typed required arguments", () => {
		for (const input of [
			{},
			{ path: null, oldText: "a", newText: "b" },
			{ path: "app.ts", oldText: 1, newText: "b" },
			{ path: "app.ts", oldText: "a", newText: ["b"] },
		]) {
			expect(projectToolUse("Edit", input).ok).toBe(false);
		}
	});

	it("caps huge text previews but reports the full byte counts", () => {
		const projected = projectToolUse("Edit", {
			path: "big.txt",
			oldText: "a".repeat(50_000),
			newText: "b".repeat(60_000),
		});
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		expect(projected.payload.arguments.oldTextBytes).toBe(50_000);
		expect(projected.payload.arguments.newTextBytes).toBe(60_000);
		expect((projected.payload.arguments.oldText as string).length).toBeLessThan(
			50_000,
		);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});
});

describe("projectToolResult — Edit", () => {
	it("re-projects the executor result field by field", () => {
		const projected = projectToolResult(
			"Edit",
			executorResultContent({ path: "src/app.ts", replacements: 3 }),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Edit",
				result: { path: "src/app.ts", replacements: 3 },
				isError: false,
				truncated: false,
			},
		});
	});

	it("omits results whose text is not the known executor shape", () => {
		expect(
			projectToolResult("Edit", [{ type: "text", text: "done" }], false).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Edit",
				executorResultContent({ path: "src/app.ts", replacements: "3" }),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Edit",
				executorResultContent({ replacements: 3 }),
				false,
			).ok,
		).toBe(false);
	});
});

describe("projectToolResult — Read", () => {
	function completedReadResult(overrides: Record<string, unknown> = {}) {
		return {
			path: "src/index.ts",
			content: "line one\nline two",
			startLine: 1,
			linesRead: 2,
			truncated: false,
			...overrides,
		};
	}

	it("re-projects the executor result field by field", () => {
		const projected = projectToolResult(
			"Read",
			executorResultContent(completedReadResult()),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Read",
				result: {
					path: "src/index.ts",
					content: "line one\nline two",
					startLine: 1,
					linesRead: 2,
					truncated: false,
				},
				isError: false,
				truncated: false,
			},
		});
	});

	it("caps a huge content preview and marks the preview incomplete", () => {
		const projected = projectToolResult(
			"Read",
			executorResultContent(
				completedReadResult({ content: "a".repeat(60_000), linesRead: 1 }),
			),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		// A preview clipped by projection is no longer the full read window,
		// exactly as when the executor's own caps truncated it.
		expect(projected.payload.result.truncated).toBe(true);
		expect((projected.payload.result.content as string).length).toBeLessThan(
			60_000,
		);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("keeps the executor's own truncated flag when the preview fits", () => {
		const projected = projectToolResult(
			"Read",
			executorResultContent(completedReadResult({ truncated: true })),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.truncated).toBe(true);
		// The event itself was not clipped by projection.
		expect(projected.payload.truncated).toBe(false);
	});

	it("omits results whose text is not the known executor shape", () => {
		expect(
			projectToolResult("Read", [{ type: "text", text: "not json" }], false).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Read",
				executorResultContent(completedReadResult({ path: 42 })),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Read",
				executorResultContent(completedReadResult({ startLine: "1" })),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Read",
				executorResultContent(completedReadResult({ linesRead: null })),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Read",
				executorResultContent(completedReadResult({ truncated: "no" })),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Read",
				executorResultContent(completedReadResult({ content: 42 })),
				false,
			).ok,
		).toBe(false);
	});
});

describe("projectToolUse — Grep", () => {
	it("exposes the search arguments", () => {
		const projected = projectToolUse("Grep", {
			pattern: "TODO\\(",
			path: "src",
			include: "*.ts",
			caseSensitive: false,
			maxResults: 50,
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Grep",
				arguments: {
					pattern: "TODO\\(",
					path: "src",
					include: "*.ts",
					caseSensitive: false,
					maxResults: 50,
				},
				truncated: false,
			},
		});
	});

	it("omits invocations with missing or wrong-typed required arguments", () => {
		for (const input of [{}, { pattern: /TODO/ }]) {
			expect(projectToolUse("Grep", input).ok).toBe(false);
		}
	});

	it("caps a huge pattern to a bounded preview and flags truncation", () => {
		const projected = projectToolUse("Grep", {
			pattern: "a|".repeat(50_000),
		});
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});
});

describe("projectToolResult — Grep", () => {
	function grepMatch(overrides: Record<string, unknown> = {}) {
		return {
			path: "src/app.ts",
			line: 12,
			column: 3,
			text: "// TODO: fix",
			...overrides,
		};
	}

	it("re-projects the executor matches field by field", () => {
		const projected = projectToolResult(
			"Grep",
			executorResultContent({
				matches: [grepMatch(), grepMatch({ path: "src/db.ts", line: 40 })],
				truncated: false,
			}),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Grep",
				result: {
					matches: [
						{ path: "src/app.ts", line: 12, column: 3, text: "// TODO: fix" },
						{ path: "src/db.ts", line: 40, column: 3, text: "// TODO: fix" },
					],
					truncated: false,
				},
				isError: false,
				truncated: false,
			},
		});
	});

	it("bounds a long match list and marks the list incomplete", () => {
		const matches = Array.from({ length: 100 }, (_, i) =>
			grepMatch({ path: `src/file-${i}.ts`, line: i + 1 }),
		);
		const projected = projectToolResult(
			"Grep",
			executorResultContent({ matches, truncated: false }),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");

		expect((projected.payload.result.matches as unknown[]).length).toBe(20);
		expect(projected.payload.result.truncated).toBe(true);
		expect(projected.payload.truncated).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("caps per-match text previews and flags truncation", () => {
		const projected = projectToolResult(
			"Grep",
			executorResultContent({
				matches: [grepMatch({ text: "x".repeat(10_000) })],
				truncated: false,
			}),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		const [match] = projected.payload.result.matches as {
			text: string;
		}[];
		if (!match) throw new Error("expected one projected match");
		expect(match.text.length).toBeLessThan(10_000);
		// The match list itself is still complete.
		expect(projected.payload.result.truncated).toBe(false);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("keeps the executor's own truncated flag when everything fits", () => {
		const projected = projectToolResult(
			"Grep",
			executorResultContent({ matches: [grepMatch()], truncated: true }),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.truncated).toBe(true);
		expect(projected.payload.truncated).toBe(false);
	});

	it("omits results whose text is not the known executor shape", () => {
		expect(
			projectToolResult(
				"Grep",
				executorResultContent({ matches: "none", truncated: false }),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Grep",
				executorResultContent({
					matches: [grepMatch({ line: "12" })],
					truncated: false,
				}),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Grep",
				executorResultContent({
					matches: [{ line: 1, column: 1, text: "no path" }],
					truncated: false,
				}),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Grep",
				executorResultContent({ matches: [grepMatch()] }),
				false,
			).ok,
		).toBe(false);
	});
});

describe("projectToolUse — Glob", () => {
	it("exposes the glob arguments", () => {
		const projected = projectToolUse("Glob", {
			pattern: "**/*.test.ts",
			path: "apps",
			includeHidden: true,
			maxResults: 100,
		});

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Glob",
				arguments: {
					pattern: "**/*.test.ts",
					path: "apps",
					includeHidden: true,
					maxResults: 100,
				},
				truncated: false,
			},
		});
	});

	it("omits invocations with missing or wrong-typed required arguments", () => {
		for (const input of [{}, { pattern: 7 }]) {
			expect(projectToolUse("Glob", input).ok).toBe(false);
		}
	});

	it("caps a huge pattern to a bounded preview and flags truncation", () => {
		const projected = projectToolUse("Glob", {
			pattern: "*/".repeat(50_000),
		});
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});
});

describe("projectToolResult — Glob", () => {
	it("re-projects the executor path list field by field", () => {
		const projected = projectToolResult(
			"Glob",
			executorResultContent({
				paths: ["a.ts", "lib/b.ts"],
				truncated: false,
			}),
			false,
		);

		expect(projected).toEqual({
			ok: true,
			payload: {
				tool: "Glob",
				result: { paths: ["a.ts", "lib/b.ts"], truncated: false },
				isError: false,
				truncated: false,
			},
		});
	});

	it("bounds a long path list and marks the list incomplete", () => {
		const paths = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);
		const projected = projectToolResult(
			"Glob",
			executorResultContent({ paths, truncated: false }),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");

		expect((projected.payload.result.paths as unknown[]).length).toBe(40);
		expect(projected.payload.result.truncated).toBe(true);
		expect(projected.payload.truncated).toBe(true);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("caps a huge per-item path preview and flags truncation", () => {
		const projected = projectToolResult(
			"Glob",
			executorResultContent({
				paths: [`${"deep/".repeat(20_000)}file.ts`],
				truncated: false,
			}),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");

		expect(projected.payload.truncated).toBe(true);
		const [first] = projected.payload.result.paths as string[];
		if (!first) throw new Error("expected one projected path");
		expect(first.length).toBeLessThan(100_000);
		// The path list itself is still complete.
		expect(projected.payload.result.truncated).toBe(false);
		expect(jsonBytes(projected.payload)).toBeLessThanOrEqual(
			TOOL_EVENT_MAX_JSON_BYTES,
		);
	});

	it("keeps the executor's own truncated flag when everything fits", () => {
		const projected = projectToolResult(
			"Glob",
			executorResultContent({ paths: ["a.ts"], truncated: true }),
			false,
		);
		if (!projected.ok) throw new Error("expected a projected payload");
		expect(projected.payload.result.truncated).toBe(true);
		expect(projected.payload.truncated).toBe(false);
	});

	it("omits results whose text is not the known executor shape", () => {
		expect(
			projectToolResult(
				"Glob",
				executorResultContent({ paths: "a.ts", truncated: false }),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Glob",
				executorResultContent({ paths: ["a.ts", 42], truncated: false }),
				false,
			).ok,
		).toBe(false);
		expect(
			projectToolResult(
				"Glob",
				executorResultContent({ paths: ["a.ts"] }),
				false,
			).ok,
		).toBe(false);
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
