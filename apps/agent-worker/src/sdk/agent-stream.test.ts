import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	assistantTextFromMessage,
	consumeAgentStream,
	QueryInterruptedError,
	type SupervisedQuery,
} from "./agent-stream";

/** A minimal assistant message carrying the given text blocks. */
function assistantMessage(...texts: string[]): SDKMessage {
	return {
		type: "assistant",
		message: {
			content: texts.map((text) => ({ type: "text", text })),
		},
		parent_tool_use_id: null,
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

/** A `result` message — the SDK's final message, which carries no appendable text. */
function resultMessage(): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "done",
	} as unknown as SDKMessage;
}

/** A terminal `result` that reports a failure without the stream throwing — the
 * SDK's clean-exit error path (`is_error: true`). */
function errorResultMessage(subtype: string, text: string): SDKMessage {
	return subtype === "success"
		? ({
				type: "result",
				subtype,
				is_error: true,
				result: text,
			} as unknown as SDKMessage)
		: ({
				type: "result",
				subtype,
				is_error: true,
				errors: [text],
			} as unknown as SDKMessage);
}

/**
 * A fake {@link SupervisedQuery}: yields the given steps in order, records
 * `interrupt()` calls, and lets a step run an arbitrary side effect (e.g. abort
 * the run's signal) before the next message is produced — so a test can drive
 * cancellation deterministically between messages. A `throwAt` step makes the
 * underlying stream reject, standing in for an SDK failure.
 */
type Step =
	| { message: SDKMessage; before?: () => void }
	| { throw: unknown; before?: () => void };

function fakeQuery(steps: Step[]): SupervisedQuery & { interrupts: number } {
	const state = { interrupts: 0 };
	const query = {
		interrupts: 0,
		async interrupt() {
			state.interrupts++;
			query.interrupts = state.interrupts;
		},
		async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
			for (const step of steps) {
				step.before?.();
				if ("throw" in step) throw step.throw;
				yield step.message;
			}
		},
	};
	return query;
}

describe("assistantTextFromMessage", () => {
	it("concatenates the text blocks of an assistant message", () => {
		expect(assistantTextFromMessage(assistantMessage("a", "b"))).toBe("ab");
	});

	it("returns null for an assistant message with no text", () => {
		expect(assistantTextFromMessage(assistantMessage())).toBeNull();
	});

	it("returns null for non-assistant messages", () => {
		expect(assistantTextFromMessage(resultMessage())).toBeNull();
	});
});

describe("consumeAgentStream", () => {
	it("appends assistant text for each assistant message while running", async () => {
		const appended: string[] = [];
		const controller = new AbortController();
		const query = fakeQuery([
			{ message: assistantMessage("hello ") },
			{ message: resultMessage() },
			{ message: assistantMessage("world") },
		]);

		await consumeAgentStream({
			query,
			signal: controller.signal,
			appendAssistantText: async (t) => {
				appended.push(t);
			},
		});

		expect(appended).toEqual(["hello ", "world"]);
		expect(query.interrupts).toBe(0);
	});

	it("ignores normal content after cancel_requested and interrupts the query", async () => {
		const appended: string[] = [];
		const controller = new AbortController();
		// The first append triggers cancellation; everything after is ignored.
		const query = fakeQuery([
			{ message: assistantMessage("kept") },
			{
				message: assistantMessage("dropped"),
				before: () => controller.abort(),
			},
			{ message: assistantMessage("also dropped") },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendAssistantText: async (t) => {
					appended.push(t);
				},
			}),
		).rejects.toBeInstanceOf(QueryInterruptedError);

		expect(appended).toEqual(["kept"]);
		expect(query.interrupts).toBe(1);
	});

	it("interrupts and appends nothing when the run is already aborted at start", async () => {
		const appended: string[] = [];
		const controller = new AbortController();
		controller.abort();
		const query = fakeQuery([{ message: assistantMessage("never") }]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendAssistantText: async (t) => {
					appended.push(t);
				},
			}),
		).rejects.toBeInstanceOf(QueryInterruptedError);

		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(1);
	});

	it("throws on a clean-exit error result so an errored run is not marked done", async () => {
		const controller = new AbortController();
		const query = fakeQuery([
			{ message: assistantMessage("thinking") },
			{ message: errorResultMessage("error_during_execution", "rate limited") },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendAssistantText: async () => {},
			}),
		).rejects.toThrow("rate limited");
		expect(query.interrupts).toBe(0);
	});

	it("does not throw on a normal successful result", async () => {
		const controller = new AbortController();
		const query = fakeQuery([
			{ message: assistantMessage("answer") },
			{ message: resultMessage() },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendAssistantText: async () => {},
			}),
		).resolves.toBeUndefined();
	});

	it("propagates an SDK stream error as a throw", async () => {
		const controller = new AbortController();
		const boom = new Error("model exploded");
		const query = fakeQuery([
			{ message: assistantMessage("partial") },
			{ throw: boom },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendAssistantText: async () => {},
			}),
		).rejects.toBe(boom);
		// Not aborted: no interrupt was requested.
		expect(query.interrupts).toBe(0);
	});
});
