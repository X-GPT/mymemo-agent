import { describe, expect, it } from "bun:test";
import {
	isAssistantTextPayload,
	isToolResultPayload,
	isToolUsePayload,
} from "./run-events";

describe("isAssistantTextPayload", () => {
	it("accepts only the authoritative complete-message payload", () => {
		expect(
			isAssistantTextPayload({ messageId: "message-1", text: "hello" }),
		).toBe(true);
		expect(isAssistantTextPayload({ text: "legacy" })).toBe(false);
		expect(isAssistantTextPayload({ messageId: 1, text: "hello" })).toBe(false);
		expect(isAssistantTextPayload({ messageId: "", text: "hello" })).toBe(
			false,
		);
		expect(isAssistantTextPayload({ messageId: "message-1", text: "" })).toBe(
			false,
		);
		expect(isAssistantTextPayload(null)).toBe(false);
	});
});

describe("isToolUsePayload", () => {
	it("accepts a client-safe Tool invocation payload", () => {
		expect(
			isToolUsePayload({
				tool: "Bash",
				arguments: { command: "ls -la", timeoutMs: 120_000 },
				truncated: false,
			}),
		).toBe(true);
		// A projection may legitimately produce an empty arguments record.
		expect(
			isToolUsePayload({ tool: "Glob", arguments: {}, truncated: true }),
		).toBe(true);
		expect(
			isToolUsePayload({
				tool: "ListDocuments",
				arguments: { limit: 20, cursorProvided: false },
				truncated: false,
			}),
		).toBe(true);
	});

	it("rejects payloads with a missing field", () => {
		expect(
			isToolUsePayload({ arguments: { command: "ls" }, truncated: false }),
		).toBe(false);
		expect(isToolUsePayload({ tool: "Bash", truncated: false })).toBe(false);
		expect(
			isToolUsePayload({ tool: "Bash", arguments: { command: "ls" } }),
		).toBe(false);
		expect(isToolUsePayload(null)).toBe(false);
		expect(isToolUsePayload(undefined)).toBe(false);
	});

	it("rejects payloads with a wrong-type field", () => {
		// Only the nine short public names are client-visible (ADR-0009); a
		// prefixed executor name or an unknown tool must fail closed.
		expect(
			isToolUsePayload({
				tool: "mcp__executor__Bash",
				arguments: {},
				truncated: false,
			}),
		).toBe(false);
		expect(isToolUsePayload({ tool: 7, arguments: {}, truncated: false })).toBe(
			false,
		);
		expect(
			isToolUsePayload({ tool: "Read", arguments: "path", truncated: false }),
		).toBe(false);
		expect(
			isToolUsePayload({ tool: "Read", arguments: ["path"], truncated: false }),
		).toBe(false);
		expect(
			isToolUsePayload({ tool: "Read", arguments: null, truncated: false }),
		).toBe(false);
		expect(
			isToolUsePayload({ tool: "Read", arguments: {}, truncated: "false" }),
		).toBe(false);
	});
});

describe("isToolResultPayload", () => {
	it("accepts a client-safe Tool result payload", () => {
		expect(
			isToolResultPayload({
				tool: "Read",
				result: { preview: "line one", lines: 1 },
				isError: false,
				truncated: true,
			}),
		).toBe(true);
		// The fixed error result (ADR-0009): error-marked, generic message.
		expect(
			isToolResultPayload({
				tool: "SearchDocuments",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			}),
		).toBe(true);
	});

	it("rejects payloads with a missing field", () => {
		expect(
			isToolResultPayload({ result: {}, isError: false, truncated: false }),
		).toBe(false);
		expect(
			isToolResultPayload({ tool: "Bash", isError: false, truncated: false }),
		).toBe(false);
		expect(
			isToolResultPayload({ tool: "Bash", result: {}, truncated: false }),
		).toBe(false);
		expect(
			isToolResultPayload({ tool: "Bash", result: {}, isError: false }),
		).toBe(false);
		expect(isToolResultPayload(null)).toBe(false);
	});

	it("rejects payloads with a wrong-type field", () => {
		expect(
			isToolResultPayload({
				tool: "NotATool",
				result: {},
				isError: false,
				truncated: false,
			}),
		).toBe(false);
		expect(
			isToolResultPayload({
				tool: "Bash",
				result: "raw stdout",
				isError: false,
				truncated: false,
			}),
		).toBe(false);
		expect(
			isToolResultPayload({
				tool: "Bash",
				result: [],
				isError: false,
				truncated: false,
			}),
		).toBe(false);
		expect(
			isToolResultPayload({
				tool: "Bash",
				result: {},
				isError: "true",
				truncated: false,
			}),
		).toBe(false);
		expect(
			isToolResultPayload({
				tool: "Bash",
				result: {},
				isError: false,
				truncated: 1,
			}),
		).toBe(false);
	});
});
