import { describe, expect, it } from "bun:test";
import {
	InvalidRunEventError,
	isToolResultPayload,
	isToolUsePayload,
	isUiPayloadEventPayload,
	parseDurableRunEvent,
	RunEventType,
	type UiPayloadEventPayload,
	validateDurableRunEventSequence,
} from "./run-events";

describe("parseDurableRunEvent", () => {
	it("parses canonical submitted, Assistant, and Tool identity events", () => {
		expect(
			parseDurableRunEvent(RunEventType.Started, {
				runId: "run-1",
				conversationId: "conversation-1",
				messageId: "user-message-1",
				message: "Summarize my notes",
				scope: "collection",
				collectionId: "collection-1",
				summaryId: null,
			}),
		).toMatchObject({
			type: RunEventType.Started,
			payload: { messageId: "user-message-1" },
		});
		expect(
			parseDurableRunEvent(RunEventType.AssistantMessageCompleted, {
				messageId: "assistant-message-1",
				text: "",
			}),
		).toEqual({
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "assistant-message-1", text: "" },
		});
		expect(
			parseDurableRunEvent(RunEventType.ToolCallStarted, {
				toolCallId: "tool-call-1",
				toolCallName: "Bash",
				parentMessageId: "assistant-message-1",
			}),
		).toMatchObject({ type: RunEventType.ToolCallStarted });
		expect(
			parseDurableRunEvent(RunEventType.ToolCallArgs, {
				toolCallId: "tool-call-1",
				delta: '{"command":"pwd"}',
			}),
		).toMatchObject({ type: RunEventType.ToolCallArgs });
		expect(
			parseDurableRunEvent(RunEventType.ToolCallCompleted, {
				toolCallId: "tool-call-1",
			}),
		).toMatchObject({ type: RunEventType.ToolCallCompleted });
		expect(
			parseDurableRunEvent(RunEventType.ToolCallResult, {
				messageId: "tool-message-1",
				toolCallId: "tool-call-1",
				content: "Command completed",
				isError: false,
			}),
		).toMatchObject({
			type: RunEventType.ToolCallResult,
			payload: { toolCallId: "tool-call-1" },
		});
	});

	it("requires terminal payload Outcome to match the durable event type", () => {
		expect(
			parseDurableRunEvent(RunEventType.Done, { outcome: "done" }),
		).toMatchObject({ type: RunEventType.Done });
		expect(
			parseDurableRunEvent(RunEventType.Error, {
				outcome: "error",
				message: "Run failed",
			}),
		).toMatchObject({ type: RunEventType.Error });
		expect(
			parseDurableRunEvent(RunEventType.Interrupted, {
				outcome: "interrupted",
			}),
		).toMatchObject({ type: RunEventType.Interrupted });

		expect(() =>
			parseDurableRunEvent(RunEventType.Done, { outcome: "error" }),
		).toThrow(InvalidRunEventError);
		expect(() => parseDurableRunEvent(RunEventType.Error, {})).toThrow(
			InvalidRunEventError,
		);
		expect(() =>
			parseDurableRunEvent(RunEventType.Error, { outcome: "error" }),
		).toThrow(InvalidRunEventError);
		expect(() =>
			parseDurableRunEvent(RunEventType.Done, {
				outcome: "done",
				message: "not a successful Outcome field",
			}),
		).toThrow(InvalidRunEventError);
	});

	it("rejects malformed known identities but skips unknown internal events", () => {
		expect(() =>
			parseDurableRunEvent(RunEventType.ToolCallStarted, {
				toolCallId: "",
				toolCallName: "mcp__executor__Bash",
				parentMessageId: "assistant-message-1",
			}),
		).toThrow(InvalidRunEventError);
		expect(() =>
			parseDurableRunEvent(RunEventType.ToolCallResult, {
				messageId: "tool-message-1",
				toolCallId: "tool-call-1",
				content: { raw: "not AG-UI content" },
				isError: false,
			}),
		).toThrow(InvalidRunEventError);
		expect(parseDurableRunEvent("worker_internal_note", { any: "shape" })).toBe(
			null,
		);
		expect(
			parseDurableRunEvent("assistant_text", {
				messageId: "obsolete-message",
				text: "obsolete",
			}),
		).toBe(null);
	});

	it("round-trips the v1 UI payload shape", () => {
		const payload = {
			messageId: "assistant-message-1",
			version: 1,
			payload: {
				component: "card",
				props: { title: "Quarterly results", tone: "info" },
				children: [
					"Revenue increased.",
					{
						component: "table",
						props: {
							columns: [{ key: "quarter", label: "Quarter" }],
							rows: [{ quarter: "Q1" }],
						},
					},
				],
			},
		} satisfies UiPayloadEventPayload;

		expect(parseDurableRunEvent(RunEventType.UiPayload, payload)).toEqual({
			type: RunEventType.UiPayload,
			payload,
		});
	});

	it("accepts future UI components and preserves unknown versions", () => {
		const futureComponent = {
			messageId: "assistant-message-1",
			version: 1,
			payload: {
				component: "timeline",
				props: { entries: [] },
			},
		};
		const futureVersion = {
			messageId: "assistant-message-1",
			version: 2,
			payload: {
				root: { kind: "timeline", entries: [] },
			},
		};

		expect(isUiPayloadEventPayload(futureComponent)).toBe(true);
		expect(isUiPayloadEventPayload(futureVersion)).toBe(true);
		expect(parseDurableRunEvent(RunEventType.UiPayload, futureVersion)).toEqual(
			{
				type: RunEventType.UiPayload,
				payload: futureVersion,
			},
		);
	});

	it("rejects structurally corrupt UI payloads", () => {
		const valid = {
			messageId: "assistant-message-1",
			version: 1,
			payload: { component: "chart", props: { spec: {} } },
		};

		expect(isUiPayloadEventPayload({ ...valid, messageId: "" })).toBe(false);
		expect(isUiPayloadEventPayload({ ...valid, version: 0 })).toBe(false);
		expect(
			isUiPayloadEventPayload({
				...valid,
				payload: { component: "", props: {} },
			}),
		).toBe(false);
		expect(
			isUiPayloadEventPayload({
				...valid,
				payload: { component: "chart", props: [] },
			}),
		).toBe(false);
		expect(
			isUiPayloadEventPayload({
				...valid,
				payload: { component: "card", props: {}, children: [42] },
			}),
		).toBe(false);
		expect(
			isUiPayloadEventPayload({
				...valid,
				payload: { component: "chart", props: {}, children: ["invalid"] },
			}),
		).toBe(false);
		expect(
			isUiPayloadEventPayload({
				...valid,
				payload: { component: "chart", props: {}, children: undefined },
			}),
		).toBe(false);
		expect(
			isUiPayloadEventPayload({
				...valid,
				payload: {
					component: "card",
					props: {},
					children: [{ component: "card", props: {} }],
				},
			}),
		).toBe(false);
		expect(
			isUiPayloadEventPayload({
				...valid,
				payload: {
					component: "card",
					props: {},
					children: [
						{
							component: "table",
							props: {},
							children: ["too deep"],
						},
					],
				},
			}),
		).toBe(false);
		expect(() =>
			parseDurableRunEvent(RunEventType.UiPayload, {
				...valid,
				payload: { component: "table" },
			}),
		).toThrow(InvalidRunEventError);
	});
});

describe("validateDurableRunEventSequence", () => {
	const started = {
		type: RunEventType.Started,
		payload: {
			runId: "run-1",
			conversationId: "conversation-1",
			messageId: "user-message-1",
			message: "Read my notes",
			scope: "general",
			collectionId: null,
			summaryId: null,
		},
	} as const;

	it("accepts Tool activity emitted before its owning Assistant completes", () => {
		expect(() =>
			validateDurableRunEventSequence([
				started,
				{
					type: RunEventType.ToolCallStarted,
					payload: {
						toolCallId: "tool-1",
						toolCallName: "Read",
						parentMessageId: "assistant-1",
					},
				},
				{
					type: RunEventType.ToolCallArgs,
					payload: { toolCallId: "tool-1", delta: '{"path":"notes.md"}' },
				},
				{
					type: RunEventType.ToolCallCompleted,
					payload: { toolCallId: "tool-1" },
				},
				{
					type: RunEventType.AssistantMessageCompleted,
					payload: { messageId: "assistant-1", text: "I checked." },
				},
				{
					type: RunEventType.ToolCallResult,
					payload: {
						messageId: "tool-message-1",
						toolCallId: "tool-1",
						content: "Read completed",
						isError: false,
					},
				},
				{ type: RunEventType.Done, payload: { outcome: "done" } },
			]),
		).not.toThrow();
	});

	it("rejects a Tool parent that collides with the submitted User message", () => {
		expect(() =>
			validateDurableRunEventSequence([
				started,
				{
					type: RunEventType.ToolCallStarted,
					payload: {
						toolCallId: "tool-1",
						toolCallName: "Read",
						parentMessageId: "user-message-1",
					},
				},
				{
					type: RunEventType.ToolCallArgs,
					payload: { toolCallId: "tool-1", delta: "{}" },
				},
				{
					type: RunEventType.ToolCallCompleted,
					payload: { toolCallId: "tool-1" },
				},
			]),
		).toThrow(InvalidRunEventError);
	});

	it("rejects more than one submitted User message", () => {
		expect(() =>
			validateDurableRunEventSequence([
				started,
				{
					type: RunEventType.Started,
					payload: {
						...started.payload,
						messageId: "user-message-2",
						message: "Second submission",
					},
				},
			]),
		).toThrow(InvalidRunEventError);
	});

	it("rejects an incomplete Tool invocation lifecycle", () => {
		expect(() =>
			validateDurableRunEventSequence([
				{
					type: RunEventType.AssistantMessageCompleted,
					payload: { messageId: "assistant-1", text: "" },
				},
				{
					type: RunEventType.ToolCallStarted,
					payload: {
						toolCallId: "tool-1",
						toolCallName: "Read",
						parentMessageId: "assistant-1",
					},
				},
			]),
		).toThrow(InvalidRunEventError);
	});

	it("requires Tool-owning Assistant completion only for a successful Run", () => {
		const completedTool = [
			{
				type: RunEventType.ToolCallStarted,
				payload: {
					toolCallId: "tool-1",
					toolCallName: "Read",
					parentMessageId: "assistant-1",
				},
			},
			{
				type: RunEventType.ToolCallArgs,
				payload: { toolCallId: "tool-1", delta: "{}" },
			},
			{
				type: RunEventType.ToolCallCompleted,
				payload: { toolCallId: "tool-1" },
			},
		] as const;

		expect(() =>
			validateDurableRunEventSequence([
				...completedTool,
				{ type: RunEventType.Done, payload: { outcome: "done" } },
			]),
		).toThrow(InvalidRunEventError);
		expect(() =>
			validateDurableRunEventSequence([
				...completedTool,
				{
					type: RunEventType.Error,
					payload: { outcome: "error", message: "Run failed" },
				},
			]),
		).not.toThrow();
	});

	it("accepts an incomplete Tool prefix closed by Reclamation", () => {
		expect(() =>
			validateDurableRunEventSequence([
				{
					type: RunEventType.ToolCallStarted,
					payload: {
						toolCallId: "tool-1",
						toolCallName: "Read",
						parentMessageId: "assistant-1",
					},
				},
				{
					type: RunEventType.Error,
					payload: {
						outcome: "error",
						message: "Run failed",
						reason: "stale_worker",
					},
				},
			]),
		).not.toThrow();
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
		// ADR-0030 removed active Glob execution, but historical events must replay.
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
