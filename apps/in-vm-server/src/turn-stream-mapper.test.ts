import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	assistantMessage,
	resultError,
	resultSuccess,
	streamEvent,
	textStep,
	toolResultMessage,
	toolStep,
} from "./testing/sdk-fixtures";
import {
	type MapperAction,
	TurnStreamMapper,
	TurnStreamProtocolError,
} from "./turn-stream-mapper";

function acceptAll(mapper: TurnStreamMapper, messages: SDKMessage[]) {
	return messages.flatMap((message) => mapper.accept(message));
}

function chunkTypes(actions: MapperAction[]): string[] {
	return actions.map((action) =>
		action.kind === "chunk" ? action.chunk.type : action.kind,
	);
}

describe("TurnStreamMapper — a text Step", () => {
	it("maps the provider envelope to start-step … step-commit", () => {
		const mapper = new TurnStreamMapper();
		const actions = acceptAll(mapper, textStep("hello"));
		expect(chunkTypes(actions)).toEqual([
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"step-commit",
		]);
		const commit = actions.at(-1);
		if (commit?.kind !== "step-commit") throw new Error("expected commit");
		expect(commit.parts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "hello", state: "done" },
		]);
	});

	it("takes durable text from the completed block, not the deltas", () => {
		const mapper = new TurnStreamMapper();
		const actions = acceptAll(mapper, [
			streamEvent({ type: "message_start", message: { id: "m" } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "partial that got lost" },
			}),
			assistantMessage([{ type: "text", text: "the complete text" }]),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		]);
		const commit = actions.at(-1);
		if (commit?.kind !== "step-commit") throw new Error("expected commit");
		expect(commit.parts).toContainEqual({
			type: "text",
			text: "the complete text",
			state: "done",
		});
	});
});

describe("TurnStreamMapper — thinking blocks", () => {
	it("maps thinking to reasoning chunks and a reasoning part", () => {
		const mapper = new TurnStreamMapper();
		const actions = acceptAll(mapper, [
			streamEvent({ type: "message_start", message: { id: "m" } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "hmm" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "sig" },
			}),
			assistantMessage([{ type: "thinking", thinking: "hmm", signature: "s" }]),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		]);
		expect(chunkTypes(actions)).toEqual([
			"start-step",
			"reasoning-start",
			"reasoning-delta",
			"reasoning-end",
			"step-commit",
		]);
		const commit = actions.at(-1);
		if (commit?.kind !== "step-commit") throw new Error("expected commit");
		expect(commit.parts).toEqual([
			{ type: "step-start" },
			{ type: "reasoning", text: "hmm", state: "done" },
		]);
	});
});

describe("TurnStreamMapper — tool use", () => {
	const bashStep = toolStep({
		toolUseId: "toolu_1",
		toolName: "Bash",
		toolInput: { command: "ls" },
	});

	it("announces the call and publishes the complete input, skipping deltas", () => {
		const mapper = new TurnStreamMapper();
		const actions = acceptAll(mapper, bashStep);
		expect(chunkTypes(actions)).toEqual([
			"start-step",
			"tool-input-start",
			"tool-input-available",
			"step-commit",
		]);
		const commit = actions.at(-1);
		if (commit?.kind !== "step-commit") throw new Error("expected commit");
		expect(commit.parts).toEqual([
			{ type: "step-start" },
			{
				type: "tool-Bash",
				toolCallId: "toolu_1",
				state: "input-available",
				input: { command: "ls" },
			},
		]);
	});

	it("maps a tool result onto the committed part as output-available", () => {
		const mapper = new TurnStreamMapper();
		acceptAll(mapper, bashStep);
		const actions = mapper.accept(toolResultMessage("toolu_1", "file.txt"));
		expect(actions).toEqual([
			{
				kind: "chunk",
				chunk: {
					type: "tool-output-available",
					toolCallId: "toolu_1",
					output: "file.txt",
				},
			},
		]);
		expect(mapper.committedParts.at(-1)).toEqual({
			type: "tool-Bash",
			toolCallId: "toolu_1",
			state: "output-available",
			input: { command: "ls" },
			output: "file.txt",
		});
	});

	it("maps a failed tool result to tool-output-error", () => {
		const mapper = new TurnStreamMapper();
		acceptAll(mapper, bashStep);
		const actions = mapper.accept(
			toolResultMessage("toolu_1", "command not found", true),
		);
		expect(actions).toEqual([
			{
				kind: "chunk",
				chunk: {
					type: "tool-output-error",
					toolCallId: "toolu_1",
					errorText: "command not found",
				},
			},
		]);
		expect(mapper.committedParts.at(-1)).toMatchObject({
			state: "output-error",
			errorText: "command not found",
		});
	});

	it("ignores a result for an unknown tool call", () => {
		const mapper = new TurnStreamMapper();
		expect(mapper.accept(toolResultMessage("toolu_ghost", "x"))).toEqual([]);
	});
});

describe("TurnStreamMapper — the terminal", () => {
	it("maps a success result to done with the Outcome in messageMetadata", () => {
		const mapper = new TurnStreamMapper();
		acceptAll(mapper, textStep("hi"));
		const actions = mapper.accept(resultSuccess());
		expect(actions).toEqual([
			{
				kind: "terminal",
				outcome: "done",
				parts: [
					{ type: "step-start" },
					{ type: "text", text: "hi", state: "done" },
				],
				chunk: { type: "finish", messageMetadata: { status: "done" } },
			},
		]);
	});

	it("maps an error result to error, discarding the Step in flight", () => {
		const mapper = new TurnStreamMapper();
		acceptAll(mapper, textStep("committed"));
		// A second Step begins streaming but never completes.
		acceptAll(mapper, [
			streamEvent({ type: "message_start", message: { id: "m2" } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "provisional" },
			}),
		]);
		const actions = mapper.accept(resultError(["API refused", "again"]));
		expect(actions).toEqual([
			{
				kind: "terminal",
				outcome: "error",
				parts: [
					{ type: "step-start" },
					{ type: "text", text: "committed", state: "done" },
				],
				chunk: { type: "error", errorText: "API refused; again" },
			},
		]);
	});

	it("falls back to the result subtype when no error strings arrive", () => {
		const mapper = new TurnStreamMapper();
		const [action] = mapper.accept(resultError());
		if (action?.kind !== "terminal") throw new Error("expected terminal");
		expect(action.chunk).toEqual({
			type: "error",
			errorText: "error_during_execution",
		});
	});

	it("ignores anything after the terminal", () => {
		const mapper = new TurnStreamMapper();
		mapper.accept(resultSuccess());
		expect(acceptAll(mapper, textStep("late"))).toEqual([]);
	});
});

describe("TurnStreamMapper — filtering", () => {
	it("keeps subagent-internal traffic out of the Turn's UIMessage", () => {
		const mapper = new TurnStreamMapper();
		acceptAll(mapper, [
			streamEvent({ type: "message_start", message: { id: "m" } }),
		]);
		expect(
			mapper.accept(
				streamEvent(
					{ type: "message_start", message: { id: "sub" } },
					"toolu_task",
				),
			),
		).toEqual([]);
		expect(
			mapper.accept(
				assistantMessage([{ type: "text", text: "sub" }], "toolu_task"),
			),
		).toEqual([]);
	});

	it("keeps redacted thinking and unknown blocks out of the durable parts", () => {
		const mapper = new TurnStreamMapper();
		const actions = acceptAll(mapper, [
			streamEvent({ type: "message_start", message: { id: "m" } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "redacted_thinking" },
			}),
			assistantMessage([{ type: "redacted_thinking", data: "opaque" }]),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		]);
		const commit = actions.at(-1);
		if (commit?.kind !== "step-commit") throw new Error("expected commit");
		expect(commit.parts).toEqual([{ type: "step-start" }]);
	});

	it("ignores status and system messages", () => {
		const mapper = new TurnStreamMapper();
		expect(
			mapper.accept({
				type: "system",
				subtype: "init",
			} as unknown as SDKMessage),
		).toEqual([]);
	});
});

describe("TurnStreamMapper — protocol violations fail closed", () => {
	it("rejects an assistant message outside a provider call", () => {
		const mapper = new TurnStreamMapper();
		expect(() =>
			mapper.accept(assistantMessage([{ type: "text", text: "x" }])),
		).toThrow(TurnStreamProtocolError);
	});

	it("rejects overlapping provider calls", () => {
		const mapper = new TurnStreamMapper();
		mapper.accept(streamEvent({ type: "message_start", message: { id: "a" } }));
		expect(() =>
			mapper.accept(
				streamEvent({ type: "message_start", message: { id: "b" } }),
			),
		).toThrow(TurnStreamProtocolError);
	});

	it("rejects a message_stop without a provider call", () => {
		const mapper = new TurnStreamMapper();
		expect(() => mapper.accept(streamEvent({ type: "message_stop" }))).toThrow(
			TurnStreamProtocolError,
		);
	});
});

describe("TurnStreamMapper — chunk ids stay unique across Steps", () => {
	it("never reuses a text chunk id in a later Step", () => {
		const mapper = new TurnStreamMapper();
		const first = acceptAll(mapper, textStep("one"));
		const second = acceptAll(mapper, textStep("two"));
		const idOf = (actions: MapperAction[], type: string) => {
			for (const action of actions) {
				if (action.kind === "chunk" && action.chunk.type === type) {
					return (action.chunk as { id: string }).id;
				}
			}
			throw new Error(`no ${type} chunk`);
		};
		expect(idOf(first, "text-start")).not.toBe(idOf(second, "text-start"));
	});
});
