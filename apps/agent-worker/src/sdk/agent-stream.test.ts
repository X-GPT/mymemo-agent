import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { InMemoryLiveTextTransport } from "@mymemo/live-text";
import type { ModelContent } from "../run-loop";
import {
	AgentResultError,
	consumeAgentStream,
	isMirrorError,
	QueryInterruptedError,
	type SupervisedQuery,
	sessionIdFromResult,
} from "./agent-stream";
import { AssistantEnvelopeProtocolError } from "./assistant-message-assembler";
import {
	assistantBlock,
	streamEvent,
	textEnvelope,
} from "./testing/sdk-message-fixtures";

function messageAt(messages: SDKMessage[], index: number): SDKMessage {
	const message = messages[index];
	if (!message)
		throw new Error(`test fixture has no message at index ${index}`);
	return message;
}

function resultMessage(sessionId?: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "terminal result echo",
		...(sessionId ? { session_id: sessionId } : {}),
	} as unknown as SDKMessage;
}

function mirrorErrorMessage(): SDKMessage {
	return {
		type: "system",
		subtype: "mirror_error",
		error: "append timed out",
		key: { projectKey: "p", sessionId: "s" },
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

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

type Step =
	| { message: SDKMessage; before?: () => void }
	| { throw: unknown; before?: () => void };

function fakeQuery(steps: Step[]): SupervisedQuery & { interrupts: number } {
	const query = {
		interrupts: 0,
		async interrupt() {
			query.interrupts++;
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

type AssistantCommit = Extract<
	ModelContent,
	{ kind: "assistant_message" }
>["payload"];

/** These fixtures only ever commit Assistant messages through the
 * discriminated model-content seam; any other kind is a bug — fail loudly
 * rather than silently dropping it. */
function onAssistantCommit(
	handle: (payload: AssistantCommit) => void,
): (content: ModelContent) => Promise<void> {
	return async (content) => {
		if (content.kind !== "assistant_message") {
			throw new Error(`unexpected model content kind: ${content.kind}`);
		}
		handle(content.payload);
	};
}

describe("sessionIdFromResult", () => {
	it("returns the session id only from a result message", () => {
		expect(sessionIdFromResult(resultMessage("session-1"))).toBe("session-1");
		expect(sessionIdFromResult(resultMessage())).toBeNull();
		expect(
			sessionIdFromResult(messageAt(textEnvelope({ completeText: "x" }), 0)),
		).toBeNull();
	});
});

describe("isMirrorError", () => {
	it("is true only for a mirror_error system message", () => {
		expect(isMirrorError(mirrorErrorMessage())).toBe(true);
		expect(isMirrorError(resultMessage())).toBe(false);
		expect(
			isMirrorError(messageAt(textEnvelope({ completeText: "x" }), 0)),
		).toBe(false);
	});
});

describe("consumeAgentStream", () => {
	it("publishes coalesced indexed preview before each sequential Assistant commit", async () => {
		const transport = new InMemoryLiveTextTransport();
		const subscription = await transport.subscribe("run-1");
		const order: string[] = [];
		const messages = [
			streamEvent({
				type: "message_start",
				message: { id: "provider-1", content: [] },
			}),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hel" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "lo" },
			}),
			assistantBlock("provider-1", { type: "text", text: "hello" }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
			...textEnvelope({
				providerMessageId: "provider-2",
				completeText: "again",
			}),
		];

		await consumeAgentStream({
			runId: "run-1",
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			liveTextPublisher: {
				async publish(message) {
					order.push(`preview:${message.text}`);
					await transport.publish(message);
				},
			},
			appendModelContent: onAssistantCommit((message) =>
				order.push(`commit:${message.text}`),
			),
		});

		const preview = subscription.readAvailable();
		expect(
			preview.map(({ deltaIndex, text }) => ({ deltaIndex, text })),
		).toEqual([
			{ deltaIndex: 0, text: "hello" },
			{ deltaIndex: 0, text: "again" },
		]);
		expect(preview[0]?.messageId).not.toBe(preview[1]?.messageId);
		expect(order).toEqual([
			"preview:hello",
			"commit:hello",
			"preview:again",
			"commit:again",
		]);
	});

	it("commits exact durable text and releases a stalled publisher without blocking the SDK stream", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		let publicationAborted = false;
		const outcome = await consumeAgentStream({
			runId: "run-1",
			query: fakeQuery(
				textEnvelope({ completeText: "authoritative" }).map((message) => ({
					message,
				})),
			),
			signal: new AbortController().signal,
			liveTextPublisher: {
				async publish(_message, options) {
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => {
								publicationAborted = true;
								resolve();
							},
							{ once: true },
						);
					});
				},
			},
			appendModelContent: onAssistantCommit((message) =>
				appended.push(message),
			),
		});

		expect(outcome).toEqual({
			sessionId: null,
			mirrorErrorObserved: false,
		});
		expect(appended.map(({ text }) => text)).toEqual(["authoritative"]);
		expect(publicationAborted).toBe(true);
	});

	it("commits only the complete provider envelope and ignores the result echo", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const controller = new AbortController();
		const query = fakeQuery([
			...textEnvelope({ completeText: "complete text" }).map((message) => ({
				message,
			})),
			{ message: resultMessage("session-42") },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: onAssistantCommit((message) =>
					appended.push(message),
				),
			}),
		).resolves.toEqual({
			sessionId: "session-42",
			mirrorErrorObserved: false,
		});
		expect(appended).toHaveLength(1);
		expect(appended[0]).toMatchObject({ text: "complete text" });
		expect(query.interrupts).toBe(0);
	});

	it("does not commit completed block evidence before message_stop", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const envelope = textEnvelope({ completeText: "complete text" });
		const query = fakeQuery([
			...envelope.slice(0, 5).map((message) => ({ message })),
			{
				message: messageAt(envelope, 5),
				before: () => expect(appended).toEqual([]),
			},
		]);

		await consumeAgentStream({
			query,
			signal: new AbortController().signal,
			appendModelContent: onAssistantCommit((message) =>
				appended.push(message),
			),
		});

		expect(appended).toHaveLength(1);
		expect(appended[0]).toMatchObject({ text: "complete text" });
	});

	it("abandons an open envelope after abort and interrupts the query once", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const controller = new AbortController();
		const envelope = textEnvelope({ completeText: "completed prefix" });
		const query = fakeQuery([
			...envelope.slice(0, 4).map((message) => ({ message })),
			{
				message: messageAt(envelope, 4),
				before: () => controller.abort(),
			},
			{ message: messageAt(envelope, 5) },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: onAssistantCommit((message) =>
					appended.push(message),
				),
			}),
		).rejects.toBeInstanceOf(QueryInterruptedError);

		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(1);
	});

	it("interrupts and commits nothing when already aborted at start", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const controller = new AbortController();
		controller.abort();
		const query = fakeQuery(
			textEnvelope({ completeText: "never" }).map((message) => ({ message })),
		);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: onAssistantCommit((message) =>
					appended.push(message),
				),
			}),
		).rejects.toBeInstanceOf(QueryInterruptedError);

		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(1);
	});

	it("abandons an open envelope on an SDK error result", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const controller = new AbortController();
		const envelope = textEnvelope({ completeText: "uncommitted" });
		const query = fakeQuery([
			...envelope.slice(0, 4).map((message) => ({ message })),
			{ message: errorResultMessage("error_during_execution", "rate limited") },
			{ throw: new Error("iterator rejected after result") },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: onAssistantCommit((message) =>
					appended.push(message),
				),
			}),
		).rejects.toThrow("rate limited");
		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(0);
	});

	it("fails closed when a nominally successful stream ends before message_stop", async () => {
		const controller = new AbortController();
		const liveText = new InMemoryLiveTextTransport();
		const subscription = await liveText.subscribe("run-1");
		const envelope = textEnvelope({ completeText: "uncommitted" });
		const query = fakeQuery(
			envelope.slice(0, 5).map((message) => ({ message })),
		);

		await expect(
			consumeAgentStream({
				runId: "run-1",
				query,
				signal: controller.signal,
				liveTextPublisher: liveText,
				appendModelContent: async () => {},
			}),
		).rejects.toBeInstanceOf(AssistantEnvelopeProtocolError);
		await Bun.sleep(60);
		expect(subscription.readAvailable()).toEqual([]);
	});

	it("does not publish pending preview when message_stop fails envelope validation", async () => {
		const liveText = new InMemoryLiveTextTransport();
		const subscription = await liveText.subscribe("run-1");
		const envelope = textEnvelope({
			completeText: "uncommitted",
			partialText: "preview",
		});
		const query = fakeQuery([
			...envelope.slice(0, 3).map((message) => ({ message })),
			{ message: streamEvent({ type: "message_stop" }) },
		]);

		await expect(
			consumeAgentStream({
				runId: "run-1",
				query,
				signal: new AbortController().signal,
				liveTextPublisher: liveText,
				appendModelContent: async () => {},
			}),
		).rejects.toBeInstanceOf(AssistantEnvelopeProtocolError);
		expect(subscription.readAvailable()).toEqual([]);
	});

	it("treats an error-bearing Assistant callback as provider rejection", async () => {
		const controller = new AbortController();
		const envelope = textEnvelope({ completeText: "rejected" });
		const rejected = assistantBlock(
			"provider-1",
			{ type: "text", text: "rejected" },
			"authentication_failed",
		);
		const query = fakeQuery([
			...envelope.slice(0, 3).map((message) => ({ message })),
			{ message: rejected },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: async () => {},
			}),
		).rejects.toBeInstanceOf(AgentResultError);
	});

	it("reports a mirror error without losing a clean session outcome", async () => {
		const controller = new AbortController();
		const query = fakeQuery([
			...textEnvelope({ completeText: "answer" }).map((message) => ({
				message,
			})),
			{ message: mirrorErrorMessage() },
			{ message: resultMessage("session-7") },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: async () => {},
			}),
		).resolves.toEqual({
			sessionId: "session-7",
			mirrorErrorObserved: true,
		});
	});

	it("propagates iterator rejection without committing an open envelope", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const controller = new AbortController();
		const boom = new Error("model exploded");
		const envelope = textEnvelope({ completeText: "uncommitted" });
		const query = fakeQuery([
			...envelope.slice(0, 4).map((message) => ({ message })),
			{ throw: boom },
		]);

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: onAssistantCommit((message) =>
					appended.push(message),
				),
			}),
		).rejects.toBe(boom);
		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(0);
	});
});
