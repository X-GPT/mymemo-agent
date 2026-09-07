import { describe, expect, it } from "bun:test";
import { createTextStream, type TextStreamChunk } from "./text-stream";

function harness() {
	const chunks: TextStreamChunk[] = [];
	const stream = createTextStream({
		messageId: "front-message",
		turnId: "turn",
		requestId: "request",
		startedAt: "2026-09-06T00:00:00.000Z",
		emit: (chunk) => chunks.push(chunk),
	});
	return {
		...stream,
		chunks,
		event: (event: Record<string, unknown>) =>
			stream.push({ type: "stream_event", event, parent_tool_use_id: null }),
	};
}

describe("SDK text to UIMessage stream", () => {
	it("folds multiple model calls once, suppressing thinking and assistant snapshots", () => {
		const h = harness();
		for (const text of ["Hello", " again"]) {
			h.event({ type: "message_start", message: { id: "provider-message" } });
			h.event({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			});
			h.event({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "secret" },
			});
			h.event({ type: "content_block_stop", index: 0 });
			h.event({
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			});
			h.event({
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text },
			});
			h.event({ type: "content_block_stop", index: 1 });
			h.event({ type: "message_stop" });
			h.push({
				type: "assistant",
				message: { content: [{ type: "text", text }] },
			});
		}
		h.push({
			type: "result",
			subtype: "success",
			is_error: false,
			result: " again",
		});
		const message = h.finish();
		expect(h.chunks.map((chunk) => chunk.type)).toEqual([
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish-step",
			"message-metadata",
			"finish",
		]);
		expect(message.parts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "Hello", state: "done" },
			{ type: "step-start" },
			{ type: "text", text: " again", state: "done" },
		]);
		expect(h.chunks[0]).toEqual({
			type: "start",
			messageId: "front-message",
			messageMetadata: {
				turnId: "turn",
				requestId: "request",
				status: "processing",
				startedAt: "2026-09-06T00:00:00.000Z",
			},
		});
		expect(message.metadata.status).toBe("done");
		expect(message.metadata.endedAt).toBeString();
		expect(JSON.stringify(h.chunks)).not.toContain("secret");
		expect(
			h.chunks.flatMap((chunk) =>
				chunk.type === "text-start" ? [chunk.id] : [],
			),
		).toEqual(["front-message:1:1", "front-message:2:1"]);
	});

	it.each([
		[
			// Pinned CLI 0.3.251's real result after Runtime budget interrupt().
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				terminal_reason: "aborted_streaming",
				errors: [
					"[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
				],
			},
			"budget_exceeded",
		],
		[
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["Request was aborted."],
			},
			"budget_exceeded",
		],
		[
			{ type: "result", subtype: "error_max_budget_usd", is_error: true },
			"budget_exceeded",
		],
		[
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["API Error: 429 rate limited"],
			},
			"quota_exceeded",
		],
		[
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["API Error: 402 payment required"],
			},
			"quota_exceeded",
		],
		[
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["secret diagnostic"],
			},
			"internal_error",
		],
		[
			{
				type: "mymemo.error",
				code: "workspace_too_large",
				detail: "secret diagnostic",
			},
			"workspace_too_large",
		],
	])("maps terminal SDK failures without leaking diagnostics: %j", (raw, code) => {
		const h = harness();
		h.push(raw);
		expect(h.finish().metadata).toMatchObject({
			status: "error",
			errorCode: code,
		});
		expect(h.chunks.at(-1)).toEqual({ type: "error", errorText: code });
		expect(h.chunks.at(-2)?.type).toBe("message-metadata");
		expect(JSON.stringify(h.chunks)).not.toContain("secret diagnostic");
	});

	it("preserves assistant quota errors when the final result is generic", () => {
		for (const error of ["billing_error", "rate_limit"]) {
			const h = harness();
			h.push({ type: "assistant", error, message: { content: [] } });
			h.push({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["Execution failed"],
			});
			expect(h.finish().metadata.errorCode).toBe("quota_exceeded");
		}
	});

	it("marks truncation as internal_error and closes streamed text", () => {
		const h = harness();
		h.event({ type: "message_start" });
		h.event({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "partial" },
		});
		const message = h.finish();
		expect(message.parts.at(-1)).toEqual({
			type: "text",
			text: "partial",
			state: "done",
		});
		expect(message.metadata.errorCode).toBe("internal_error");
		expect(h.chunks.slice(-4).map((chunk) => chunk.type)).toEqual([
			"text-end",
			"finish-step",
			"message-metadata",
			"error",
		]);
	});

	it("fails closed without a result and lets transport or runtime errors override success", () => {
		expect(harness().finish().metadata.errorCode).toBe("internal_error");
		for (const viaRuntime of [true, false]) {
			const h = harness();
			h.push({ type: "result", subtype: "success", is_error: false });
			if (viaRuntime) h.push({ type: "mymemo.error", code: "internal_error" });
			expect(
				h.finish(viaRuntime ? undefined : "internal_error").metadata.errorCode,
			).toBe("internal_error");
			const count = h.chunks.length;
			h.finish();
			expect(h.chunks.length).toBe(count);
		}
	});
});

it("converts hand and docs tools once with public names and capped outputs", () => {
	const h = harness();
	const names = [
		"Bash",
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"ListDocuments",
		"SearchDocuments",
		"LoadDocuments",
	] as const;
	for (const name of names) {
		const call = {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: name,
						name: name.endsWith("Documents")
							? `mcp__docs__${name}`
							: `mcp__hand__${name.toLowerCase()}`,
						input: { path: "/ws/notes.txt" },
					},
				],
			},
		};
		h.push(call);
		h.push(call);
		h.push({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: name,
						content: "😀".repeat(3000),
					},
				],
			},
		});
	}
	h.push({ type: "result", subtype: "success" });
	const message = h.finish();
	expect(message.metadata.status).toBe("done");
	expect(message.parts).toHaveLength(names.length);
	for (const part of message.parts) {
		expect(part).toMatchObject({
			state: "output-available",
			output: { value: "😀".repeat(2048), truncated: true, totalBytes: 12000 },
		});
	}
	expect(
		h.chunks
			.filter((chunk) => chunk.type === "tool-input-available")
			.map((chunk) => chunk.toolName),
	).toEqual([...names]);
	expect(
		h.chunks.filter((chunk) => chunk.type === "tool-output-available"),
	).toHaveLength(names.length);
});

it("keeps UTF-8 truncation valid and emits failures as tool-output-error", () => {
	const h = harness();
	for (const [id, content, is_error] of [
		["unicode", `${"a".repeat(8191)}😀`, false],
		["error", "missing file", true],
		["json", [{ type: "text", text: "ok" }], false],
	] as const) {
		h.push({
			type: "assistant",
			message: { content: [{ type: "tool_use", id, name: "Read", input: {} }] },
		});
		h.push({
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: id, content, is_error }],
			},
		});
	}
	expect(
		h.chunks.find((chunk) => chunk.type === "tool-output-available"),
	).toEqual({
		type: "tool-output-available",
		toolCallId: "unicode",
		output: { value: "a".repeat(8191), truncated: true, totalBytes: 8195 },
	});
	expect(h.chunks).toContainEqual({
		type: "tool-output-error",
		toolCallId: "error",
		errorText: "missing file",
	});
	expect(h.message.parts[1]).toEqual({
		type: "tool-Read",
		toolCallId: "error",
		input: {},
		state: "output-error",
		errorText: "missing file",
	});
	expect(h.message.parts[2]).toMatchObject({
		output: {
			value: '[{"type":"text","text":"ok"}]',
			truncated: false,
			totalBytes: 29,
		},
	});
});

it("exposes result and fatal Runtime error status for workspace copy-out", () => {
	const stream = createTextStream({
		messageId: "m",
		turnId: "t",
		requestId: "r",
		startedAt: "now",
		emit: () => {},
	});
	expect(stream.hasResult).toBe(false);
	expect(stream.fatalRuntimeError).toBe(false);
	stream.push({ type: "result", subtype: "success" });
	expect(stream.hasResult).toBe(true);
	stream.push({ type: "mymemo.error", code: "internal_error" });
	expect(stream.fatalRuntimeError).toBe(true);
});

it("PresentUI retries emit only validated data, retained in the reply without tool parts", () => {
	const h = harness();
	const payload = {
		component: "table" as const,
		props: { columns: [{ key: "x", label: "X" }], rows: [{ x: 42 }] },
	};
	for (const [id, input, failed] of [
		["bad", { component: "image", props: {} }, true],
		["ok", payload, false],
	] as const) {
		h.push({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", name: "PresentUI", id, input }],
			},
		});
		expect(
			h.chunks.filter((c) => c.type === "data-generative-ui"),
		).toHaveLength(0);
		h.push({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						is_error: failed,
						content: "ack",
					},
				],
			},
		});
	}
	const data = h.chunks.filter((c) => c.type === "data-generative-ui");
	expect(data).toEqual([
		{
			type: "data-generative-ui",
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			data: { version: 1, payload },
		},
	]);
	expect(h.chunks.some((c) => c.type.startsWith("tool-"))).toBe(false);
	h.push({ type: "result", subtype: "success" });
	expect(h.finish().parts).toEqual(data);
});

it("artifact changes precede terminal metadata on done and error, unchanged mirrors emit nothing", () => {
	for (const subtype of ["success", "error_during_execution"]) {
		const h = harness();
		h.push({ type: "result", subtype });
		h.artifacts({ artifacts: [], removed: [] });
		expect(h.chunks.filter((c) => c.type === "data-artifacts")).toHaveLength(0);
		h.artifacts({ artifacts: [], removed: ["deleted-id"] });
		const message = h.finish();
		expect(h.chunks.map((c) => c.type)).toEqual([
			"start",
			"data-artifacts",
			"message-metadata",
			subtype === "success" ? "finish" : "error",
		]);
		expect(message.parts).toEqual([
			{
				type: "data-artifacts",
				id: "turn",
				data: { artifacts: [], removed: ["deleted-id"] },
			},
		]);
	}
});
