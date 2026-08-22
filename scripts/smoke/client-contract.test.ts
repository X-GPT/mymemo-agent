import { describe, expect, it } from "bun:test";
import {
	createClientContractFixture,
	readClientContractSse,
} from "./client-contract";

describe("AG-UI smoke client contract", () => {
	it("assembles split data-only SSE deltas around a heartbeat", () => {
		const raw = [
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
			{ type: "ping" },
			{ type: "TEXT_MESSAGE_START", messageId: "assistant-1" },
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "assistant-1",
				delta: "LOCAL_AGENTCORE",
			},
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "assistant-1",
				delta: "_OK",
			},
			{ type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "run-1" },
		]
			.map((data) => `data: ${JSON.stringify(data)}\n\n`)
			.join("");

		expect(readClientContractSse(raw)).toEqual({
			messages: [
				{
					messageId: "assistant-1",
					text: "LOCAL_AGENTCORE_OK",
					provisional: false,
				},
			],
			toolEvents: [],
			terminal: "done",
		});
	});

	it("assembles standard Assistant text, Tool activity, and a successful Outcome", () => {
		const client = createClientContractFixture();
		for (const data of [
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
			{ type: "TEXT_MESSAGE_START", messageId: "assistant-1" },
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "assistant-1",
				delta: "hel",
			},
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "assistant-1",
				delta: "lo",
			},
			{ type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
			{
				type: "TOOL_CALL_START",
				toolCallId: "tool-1",
				toolCallName: "Read",
				parentMessageId: "assistant-1",
			},
			{ type: "TOOL_CALL_ARGS", toolCallId: "tool-1", delta: "{}" },
			{ type: "TOOL_CALL_END", toolCallId: "tool-1" },
			{
				type: "TOOL_CALL_RESULT",
				messageId: "tool-message-1",
				toolCallId: "tool-1",
				content: "{}",
				role: "tool",
			},
			{ type: "RUN_FINISHED", threadId: "conv-1", runId: "run-1" },
		] as const) {
			client.receive({ event: data.type, data });
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

	it("drops incomplete Assistant text when the Run is interrupted", () => {
		const client = createClientContractFixture();
		for (const data of [
			{ type: "RUN_STARTED", threadId: "conv-1", runId: "run-1" },
			{ type: "TEXT_MESSAGE_START", messageId: "assistant-1" },
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "assistant-1",
				delta: "temporary",
			},
			{ type: "RUN_INTERRUPTED", threadId: "conv-1", runId: "run-1" },
		] as const) {
			client.receive({ event: data.type, data });
		}

		expect(client.snapshot()).toEqual({
			messages: [],
			toolEvents: [],
			terminal: "interrupted",
		});
	});

	it("rejects malformed and out-of-order standard events", () => {
		const client = createClientContractFixture();
		expect(() =>
			client.receive({
				event: "RUN_STARTED",
				data: { type: "RUN_FINISHED", threadId: "conv-1", runId: "run-1" },
			}),
		).toThrow("invalid RUN_STARTED frame");
		expect(() =>
			client.receive({
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
