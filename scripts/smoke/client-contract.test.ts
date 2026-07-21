import { describe, expect, it } from "bun:test";
import { createClientContractFixture } from "./client-contract";

describe("AG-UI smoke client contract", () => {
	it("assembles standard Assistant text, Tool activity, and a successful Outcome", () => {
		const client = createClientContractFixture();
		for (const [id, data] of [
			["1-0", { type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" }],
			["2-0", { type: "TEXT_MESSAGE_START", messageId: "assistant-1" }],
			[
				"3-0",
				{
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "assistant-1",
					delta: "hel",
				},
			],
			[
				"4-0",
				{
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "assistant-1",
					delta: "lo",
				},
			],
			["5-0", { type: "TEXT_MESSAGE_END", messageId: "assistant-1" }],
			[
				"6-0",
				{
					type: "TOOL_CALL_START",
					toolCallId: "tool-1",
					toolCallName: "Read",
					parentMessageId: "assistant-1",
				},
			],
			["7-0", { type: "TOOL_CALL_ARGS", toolCallId: "tool-1", delta: "{}" }],
			["8-0", { type: "TOOL_CALL_END", toolCallId: "tool-1" }],
			[
				"9-0",
				{
					type: "TOOL_CALL_RESULT",
					messageId: "tool-message-1",
					toolCallId: "tool-1",
					content: "{}",
					role: "tool",
				},
			],
			["10-0", { type: "RUN_FINISHED", threadId: "conv-1", runId: "run-1" }],
		] as const) {
			client.receive({ id, event: data.type, data });
		}

		expect(client.snapshot()).toEqual({
			messages: [
				{ messageId: "assistant-1", text: "hello", provisional: false },
			],
			toolEvents: [
				{
					kind: "tool_call_start",
					toolCallId: "tool-1",
					tool: "Read",
					parentMessageId: "assistant-1",
				},
				{ kind: "tool_call_args", toolCallId: "tool-1", delta: "{}" },
				{ kind: "tool_call_end", toolCallId: "tool-1" },
				{
					kind: "tool_call_result",
					messageId: "tool-message-1",
					toolCallId: "tool-1",
					content: "{}",
				},
			],
			terminal: "done",
		});
	});

	it("drops incomplete Assistant text when the Run is canceled", () => {
		const client = createClientContractFixture();
		for (const [id, data] of [
			["1-0", { type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" }],
			["2-0", { type: "TEXT_MESSAGE_START", messageId: "assistant-1" }],
			[
				"3-0",
				{
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "assistant-1",
					delta: "temporary",
				},
			],
			["4-0", { type: "RUN_CANCELLED", threadId: "conv-1", runId: "run-1" }],
		] as const) {
			client.receive({ id, event: data.type, data });
		}

		expect(client.snapshot()).toEqual({
			messages: [],
			toolEvents: [],
			terminal: "canceled",
		});
	});

	it("rejects cursorless and out-of-order standard events", () => {
		const client = createClientContractFixture();
		expect(() =>
			client.receive({
				event: "RUN_STARTED",
				data: { type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
			}),
		).toThrow("replay cursor");
		expect(() =>
			client.receive({
				id: "1-0",
				event: "TEXT_MESSAGE_CONTENT",
				data: {
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "assistant-1",
					delta: "orphan",
				},
			}),
		).toThrow("no open message");
	});
});
