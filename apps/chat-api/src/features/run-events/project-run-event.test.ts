import { describe, expect, it } from "bun:test";
import { projectRunEvent } from "./project-run-event";
import { RunEventType } from "./run-event-types";

describe("projectRunEvent", () => {
	it("fans run_started out to conversation_id then run_id, in that order", () => {
		expect(
			projectRunEvent(RunEventType.Started, {
				conversationId: "conv-1",
				runId: "run-1",
			}),
		).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
		]);
	});

	it("maps a complete assistant_text payload to text_commit", () => {
		expect(
			projectRunEvent(RunEventType.AssistantText, {
				messageId: "message-1",
				text: "hi",
			}),
		).toEqual([{ type: "text_commit", messageId: "message-1", text: "hi" }]);
	});

	it("maps run_done to done", () => {
		expect(projectRunEvent(RunEventType.Done, {})).toEqual([{ type: "done" }]);
	});

	it("maps run_canceled to canceled, never error", () => {
		expect(projectRunEvent(RunEventType.Canceled, {})).toEqual([
			{ type: "canceled" },
		]);
	});

	it("maps run_error to an error frame carrying the message", () => {
		expect(projectRunEvent(RunEventType.Error, { message: "boom" })).toEqual([
			{ type: "error", message: "boom" },
		]);
	});

	it("still emits a terminal error frame when the payload has no message", () => {
		expect(projectRunEvent(RunEventType.Error, {})).toEqual([
			{ type: "error", message: "Run failed" },
		]);
	});

	it("maps a guard-valid tool_use payload to a tool_use frame", () => {
		expect(
			projectRunEvent(RunEventType.ToolUse, {
				tool: "Bash",
				arguments: { command: "ls -la", cwd: "src", timeoutMs: 30_000 },
				truncated: false,
			}),
		).toEqual([
			{
				type: "tool_use",
				tool: "Bash",
				arguments: { command: "ls -la", cwd: "src", timeoutMs: 30_000 },
				truncated: false,
			},
		]);
	});

	it("maps a guard-valid tool_result payload to a tool_result frame", () => {
		expect(
			projectRunEvent(RunEventType.ToolResult, {
				tool: "Bash",
				result: { exitCode: 2, stdout: "", stderr: "no such file" },
				isError: false,
				truncated: true,
			}),
		).toEqual([
			{
				type: "tool_result",
				tool: "Bash",
				result: { exitCode: 2, stdout: "", stderr: "no such file" },
				isError: false,
				truncated: true,
			},
		]);
	});

	it("maps the fixed error result payload unchanged", () => {
		expect(
			projectRunEvent(RunEventType.ToolResult, {
				tool: "Bash",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			}),
		).toEqual([
			{
				type: "tool_result",
				tool: "Bash",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			},
		]);
	});

	it("drops malformed tool payloads without emitting a frame", () => {
		// Missing fields.
		expect(
			projectRunEvent(RunEventType.ToolUse, { tool: "Bash", truncated: false }),
		).toEqual([]);
		expect(
			projectRunEvent(RunEventType.ToolResult, {
				tool: "Bash",
				result: {},
				isError: false,
			}),
		).toEqual([]);
		// A non-public tool name must never reach the client stream.
		expect(
			projectRunEvent(RunEventType.ToolUse, {
				tool: "mcp__mymemo-executor__Bash",
				arguments: {},
				truncated: false,
			}),
		).toEqual([]);
		// Wrong-typed fields and non-object payloads.
		expect(
			projectRunEvent(RunEventType.ToolResult, {
				tool: "Bash",
				result: "raw text",
				isError: false,
				truncated: false,
			}),
		).toEqual([]);
		expect(projectRunEvent(RunEventType.ToolUse, null)).toEqual([]);
		expect(projectRunEvent(RunEventType.ToolResult, undefined)).toEqual([]);
	});

	it("skips unmapped internal event types (fail-closed)", () => {
		expect(projectRunEvent("document_search", { query: "x" })).toEqual([]);
		expect(projectRunEvent("daemon_started", {})).toEqual([]);
		expect(projectRunEvent("some_future_event", { secret: "leak" })).toEqual(
			[],
		);
	});

	it("drops frames whose payload fields are the wrong shape", () => {
		// run_started with a non-string conversationId keeps only the valid field.
		expect(
			projectRunEvent(RunEventType.Started, { conversationId: 42, runId: "r" }),
		).toEqual([{ type: "run_id", runId: "r" }]);
		// assistant_text requires both authoritative payload fields; legacy
		// text-only rows are deliberately not backfilled or projected.
		expect(projectRunEvent(RunEventType.AssistantText, { text: 7 })).toEqual(
			[],
		);
		expect(
			projectRunEvent(RunEventType.AssistantText, { text: "legacy" }),
		).toEqual([]);
	});

	it("tolerates a null or non-object payload without throwing", () => {
		expect(projectRunEvent(RunEventType.AssistantText, null)).toEqual([]);
		expect(projectRunEvent(RunEventType.Started, "nope")).toEqual([]);
		expect(projectRunEvent(RunEventType.Done, undefined)).toEqual([
			{ type: "done" },
		]);
	});
});
