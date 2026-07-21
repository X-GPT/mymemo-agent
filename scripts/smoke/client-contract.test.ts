import { describe, expect, it } from "bun:test";
import { createClientContractFixture } from "./client-contract";

describe("hard-cutover client contract", () => {
	it("appends provisional deltas and replaces them with the authoritative commit", () => {
		const client = createClientContractFixture();

		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 0,
				text: "provi",
			},
		});
		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 1,
				text: "sional",
			},
		});
		expect(client.snapshot()).toEqual({
			messages: [
				{ messageId: "message-1", text: "provisional", provisional: true },
			],
			toolEvents: [],
			terminal: undefined,
		});

		client.receive({
			id: "2",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-1",
				text: "authoritative",
			},
		});
		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 2,
				text: "late",
			},
		});

		expect(client.snapshot()).toEqual({
			messages: [
				{
					messageId: "message-1",
					text: "authoritative",
					provisional: false,
				},
			],
			toolEvents: [],
			terminal: undefined,
		});
	});

	it("creates commits without preview and reconciles multiple message ids independently", () => {
		const client = createClientContractFixture();

		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 0,
				text: "first preview",
			},
		});
		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-2",
				deltaIndex: 0,
				text: "second preview",
			},
		});
		client.receive({
			id: "2",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-1",
				text: "first commit",
			},
		});
		client.receive({
			id: "3",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-2",
				text: "second commit",
			},
		});
		client.receive({
			id: "4",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-3",
				text: "third commit",
			},
		});

		expect(client.snapshot().messages).toEqual([
			{ messageId: "message-1", text: "first commit", provisional: false },
			{ messageId: "message-2", text: "second commit", provisional: false },
			{ messageId: "message-3", text: "third commit", provisional: false },
		]);
	});

	for (const terminal of ["done", "canceled", "error"] as const) {
		it(`clears uncommitted preview on ${terminal}`, () => {
			const client = createClientContractFixture();
			client.receive({
				event: "text_delta",
				data: {
					type: "text_delta",
					messageId: "preview",
					deltaIndex: 0,
					text: "discard me",
				},
			});
			client.receive({
				id: "9",
				event: terminal,
				data:
					terminal === "error"
						? { type: "error", message: "Run failed" }
						: { type: terminal },
			});
			client.receive({
				event: "text_delta",
				data: {
					type: "text_delta",
					messageId: "late-preview",
					deltaIndex: 0,
					text: "must not resurrect",
				},
			});

			expect(client.snapshot()).toEqual({
				messages: [],
				toolEvents: [],
				terminal,
			});
		});
	}

	it("records correlated tool lifecycle events in arrival order", () => {
		const client = createClientContractFixture();

		client.receive({
			id: "2",
			event: "TOOL_CALL_START",
			data: {
				type: "TOOL_CALL_START",
				toolCallId: "tool-1",
				toolCallName: "Bash",
				parentMessageId: "assistant-1",
			},
		});
		client.receive({
			id: "3",
			event: "TOOL_CALL_ARGS",
			data: {
				type: "TOOL_CALL_ARGS",
				toolCallId: "tool-1",
				delta: '{"command":"ls -la"}',
			},
		});
		client.receive({
			id: "4",
			event: "TOOL_CALL_END",
			data: {
				type: "TOOL_CALL_END",
				toolCallId: "tool-1",
			},
		});
		client.receive({
			id: "5",
			event: "TOOL_CALL_RESULT",
			data: {
				type: "TOOL_CALL_RESULT",
				messageId: "tool-message-1",
				toolCallId: "tool-1",
				content: '{"exitCode":0,"stdout":"a.ts\\n"}',
				role: "tool",
			},
		});
		client.receive({
			id: "5",
			event: "CUSTOM",
			data: {
				type: "CUSTOM",
				name: "mymemo.tool_result_error",
				value: { messageId: "tool-message-1", toolCallId: "tool-1" },
			},
		});

		expect(client.snapshot().toolEvents).toEqual([
			{
				kind: "tool_call_start",
				toolCallId: "tool-1",
				tool: "Bash",
				parentMessageId: "assistant-1",
			},
			{
				kind: "tool_call_args",
				toolCallId: "tool-1",
				delta: '{"command":"ls -la"}',
			},
			{ kind: "tool_call_end", toolCallId: "tool-1" },
			{
				kind: "tool_call_result",
				messageId: "tool-message-1",
				toolCallId: "tool-1",
				content: '{"exitCode":0,"stdout":"a.ts\\n"}',
			},
			{
				kind: "custom",
				name: "mymemo.tool_result_error",
				value: { messageId: "tool-message-1", toolCallId: "tool-1" },
			},
		]);
	});

	it("rejects cursorless or malformed tool frames", () => {
		const client = createClientContractFixture();

		// The legacy route projects canonical Tool events from durable rows, so
		// every frame carries its Run-event cursor.
		expect(() =>
			client.receive({
				event: "TOOL_CALL_START",
				data: {
					type: "TOOL_CALL_START",
					toolCallId: "tool-1",
					toolCallName: "Bash",
					parentMessageId: "assistant-1",
				},
			}),
		).toThrow("TOOL_CALL_START must carry a durable cursor");
		expect(() =>
			client.receive({
				id: "2",
				event: "TOOL_CALL_START",
				data: { type: "TOOL_CALL_START", toolCallId: "tool-1" },
			}),
		).toThrow("invalid TOOL_CALL_START frame");
		expect(() =>
			client.receive({
				id: "2",
				event: "TOOL_CALL_RESULT",
				data: {
					type: "TOOL_CALL_RESULT",
					messageId: "tool-message-1",
					toolCallId: "tool-1",
					content: "raw text",
					role: "assistant",
				},
			}),
		).toThrow("invalid TOOL_CALL_RESULT frame");
	});

	it("ignores tool frames after the terminal outcome", () => {
		const client = createClientContractFixture();
		client.receive({ id: "9", event: "done", data: { type: "done" } });
		client.receive({
			id: "10",
			event: "TOOL_CALL_START",
			data: {
				type: "TOOL_CALL_START",
				toolCallId: "tool-1",
				toolCallName: "Bash",
				parentMessageId: "assistant-1",
			},
		});

		expect(client.snapshot().toolEvents).toEqual([]);
	});

	it("rejects cursor-bearing preview and the former text-only durable delta", () => {
		const client = createClientContractFixture();

		expect(() =>
			client.receive({
				id: "2",
				event: "text_delta",
				data: {
					type: "text_delta",
					messageId: "message-1",
					deltaIndex: 0,
					text: "preview",
				},
			}),
		).toThrow("text_delta must be cursorless");
		expect(() =>
			client.receive({
				event: "text_delta",
				data: { type: "text_delta", text: "legacy durable message" },
			}),
		).toThrow("invalid text_delta frame");
		expect(() =>
			client.receive({
				id: "2",
				event: "assistant_text",
				data: { type: "assistant_text", text: "legacy alias" },
			}),
		).toThrow("unsupported client event assistant_text");
		expect(() =>
			client.receive({
				id: "3",
				event: "tool_use",
				data: { type: "tool_use", tool: "Bash" },
			}),
		).toThrow("unsupported client event tool_use");
	});
});
