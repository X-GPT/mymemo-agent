import { describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelContent } from "../run-loop";
import {
	AgentResultError,
	type ConsumeAgentStreamParams,
	consumeAgentStream,
	isMirrorError,
	type SupervisedQuery,
} from "./agent-stream";
import { AssistantEnvelopeProtocolError } from "./assistant-message-assembler";
import {
	assistantBlock,
	streamEvent,
	textEnvelope,
	toolEnvelope,
	toolResultUserMessage,
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

function mirrorErrorMessage(error = "provider transcript detail"): SDKMessage {
	return {
		type: "system",
		subtype: "mirror_error",
		error,
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

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function fakeQuery(steps: Step[]): SupervisedQuery & { interrupts: number } {
	const query = {
		interrupts: 0,
		close() {},
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

const noopRunScopeAbort: ConsumeAgentStreamParams["abortRunScopedWork"] =
	() => {};

async function streamFailure(
	result: ReturnType<typeof consumeAgentStream>,
): Promise<unknown> {
	const outcome = await result;
	expect(outcome.disposition).toBe("failed");
	if (outcome.disposition !== "failed") {
		throw new Error(`expected failed stream, received ${outcome.disposition}`);
	}
	expect(outcome.mirrorErrorObserved).toBe(false);
	return outcome.error;
}

type AssistantCommit = Extract<
	ModelContent,
	{ kind: "assistant_message" }
>["payload"];

/** Record every atomic model-content batch, preserving event order. */
function captureModelContents(
	appended: ModelContent[],
): (contents: readonly ModelContent[]) => Promise<void> {
	return async (contents) => {
		appended.push(...contents);
	};
}

type ModelContentPayloadByKind = {
	[Kind in ModelContent["kind"]]: Extract<
		ModelContent,
		{ kind: Kind }
	>["payload"];
};

function payloadsOfKind<Kind extends ModelContent["kind"]>(
	contents: ModelContent[],
	kind: Kind,
): ModelContentPayloadByKind[Kind][] {
	const payloads: ModelContentPayloadByKind[Kind][] = [];
	for (const content of contents) {
		if (content.kind === kind) {
			payloads.push(content.payload as ModelContentPayloadByKind[Kind]);
		}
	}
	return payloads;
}

function spyLogger() {
	const warnings: Record<string, unknown>[] = [];
	return {
		logger: {
			info: () => {},
			warn: (obj: Record<string, unknown>) => {
				warnings.push(obj);
			},
			error: () => {},
		},
		warnings,
	};
}

/** The structured JSON text the executor Bash tool returns on success. */
function bashResultText(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		exitCode: 0,
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
		outcome: "completed",
		...overrides,
	});
}

/** These fixtures only ever commit Assistant messages through the
 * discriminated model-content seam; any other kind is a bug — fail loudly
 * rather than silently dropping it. */
function onAssistantCommit(
	handle: (payload: AssistantCommit) => void,
): (contents: readonly ModelContent[]) => Promise<void> {
	return async (contents) => {
		for (const content of contents) {
			if (content.kind !== "assistant_message") {
				throw new Error(`unexpected model content kind: ${content.kind}`);
			}
			handle(content.payload);
		}
	};
}

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
	it("emits standard Assistant text events and commits before message end", async () => {
		const order: string[] = [];
		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(
				textEnvelope({ completeText: "hello" }).map((message) => ({ message })),
			),
			interruptionSignal: new AbortController().signal,
			appendLiveEvent: async (event) => {
				if (event.type === EventType.TEXT_MESSAGE_END) {
					expect(order).toContain("commit:hello");
				}
				order.push(event.type);
			},
			appendModelContents: onAssistantCommit((message) =>
				order.push(`commit:${message.text}`),
			),
		});

		expect(order).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			"commit:hello",
			EventType.TEXT_MESSAGE_END,
		]);
	});

	it("coalesces provider text fragments before Live Stream publication", async () => {
		const messages = textEnvelope({
			completeText: "hello",
			partialText: "hel",
		});
		messages.splice(
			3,
			0,
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "lo" },
			}),
		);
		const events: Array<Record<string, unknown>> = [];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendLiveEvent: async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
			appendModelContents: async () => {},
		});

		expect(events).toEqual([
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: expect.any(String),
				role: "assistant",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: expect.any(String),
				delta: "hello",
			},
			{
				type: EventType.TEXT_MESSAGE_END,
				messageId: expect.any(String),
			},
		]);
	});

	it("waits for an in-flight content append before surfacing failure", async () => {
		const contentStarted = deferred();
		const releaseContent = deferred();
		const messages = textEnvelope({ completeText: "hello" });
		const query: SupervisedQuery = {
			close() {},
			async interrupt() {},
			async *[Symbol.asyncIterator]() {
				for (const message of messages.slice(0, 3)) yield message;
				await contentStarted.promise;
				yield errorResultMessage("error_during_execution", "provider failed");
			},
		};
		let settled = false;

		const result = streamFailure(
			consumeAgentStream({
				abortRunScopedWork: noopRunScopeAbort,
				query,
				interruptionSignal: new AbortController().signal,
				appendLiveEvent: async (event) => {
					if (event.type !== EventType.TEXT_MESSAGE_CONTENT) return;
					contentStarted.resolve();
					await releaseContent.promise;
				},
				appendModelContents: async () => {},
			}),
		);
		void result.then(() => {
			settled = true;
		});

		await contentStarted.promise;
		await Bun.sleep(0);
		expect(settled).toBe(false);

		releaseContent.resolve();
		expect(await result).toBeInstanceOf(AgentResultError);
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
				abortRunScopedWork: noopRunScopeAbort,
				query,
				interruptionSignal: controller.signal,
				appendModelContents: onAssistantCommit((message) =>
					appended.push(message),
				),
			}),
		).resolves.toEqual({
			disposition: "completed",
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
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: new AbortController().signal,
			appendModelContents: onAssistantCommit((message) =>
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

		const outcome = await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: controller.signal,
			appendModelContents: onAssistantCommit((message) =>
				appended.push(message),
			),
		});

		expect(outcome.disposition).toBe("stopped");
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

		const outcome = await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: controller.signal,
			appendModelContents: onAssistantCommit((message) =>
				appended.push(message),
			),
		});

		expect(outcome.disposition).toBe("stopped");
		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(1);
	});

	it("does not double-close when ownership is lost during the stop grace", async () => {
		const stopController = new AbortController();
		const ownershipController = new AbortController();
		const releaseStream = deferred();
		const deadlineElapsed = deferred();
		let interrupts = 0;
		let closes = 0;
		const query: SupervisedQuery = {
			async interrupt() {
				interrupts++;
			},
			close() {
				closes++;
			},
			// biome-ignore lint/correctness/useYield: the held-open stream exercises stop races.
			async *[Symbol.asyncIterator]() {
				await releaseStream.promise;
			},
		};
		const consuming = consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: stopController.signal,
			ownershipLostSignal: ownershipController.signal,
			appendModelContents: async () => {},
			startStopDeadline: () => ({
				elapsed: deadlineElapsed.promise,
				cancel() {},
			}),
		});

		stopController.abort();
		await Promise.resolve();
		expect(interrupts).toBe(1);
		expect(closes).toBe(0);

		ownershipController.abort();
		expect(closes).toBe(1);
		deadlineElapsed.resolve();
		await Promise.resolve();
		expect(closes).toBe(1);

		releaseStream.resolve();
		expect((await consuming).disposition).toBe("stopped");
	});

	it("settles after forced close even when the SDK iterator stays hung", async () => {
		const stopController = new AbortController();
		const streamStarted = deferred();
		const deadlineElapsed = deferred();
		let closes = 0;
		let returns = 0;
		const query: SupervisedQuery = {
			async interrupt() {},
			close() {
				closes++;
			},
			[Symbol.asyncIterator]() {
				return {
					next() {
						streamStarted.resolve();
						return new Promise<IteratorResult<SDKMessage>>(() => {});
					},
					async return() {
						returns++;
						return { done: true, value: undefined };
					},
				};
			},
		};
		const consuming = consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: stopController.signal,
			appendModelContents: async () => {},
			startStopDeadline: () => ({
				elapsed: deadlineElapsed.promise,
				cancel() {},
			}),
		});
		await streamStarted.promise;

		stopController.abort();
		deadlineElapsed.resolve();

		expect(await consuming).toMatchObject({ disposition: "stopped" });
		expect(closes).toBe(1);
		expect(returns).toBe(1);
	});

	it("logs a late SDK rejection after an operational force-close", async () => {
		const forceCloseController = new AbortController();
		const streamStarted = deferred();
		const nextMessage = Promise.withResolvers<IteratorResult<SDKMessage>>();
		const errors: Record<string, unknown>[] = [];
		const query: SupervisedQuery = {
			async interrupt() {},
			close() {},
			[Symbol.asyncIterator]() {
				return {
					next() {
						streamStarted.resolve();
						return nextMessage.promise;
					},
				};
			},
		};
		const consuming = consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: new AbortController().signal,
			forceCloseSignals: [forceCloseController.signal],
			appendModelContents: async () => {},
			logger: {
				info() {},
				warn() {},
				error(fields) {
					errors.push(fields);
				},
			},
		});
		await streamStarted.promise;

		forceCloseController.abort();
		expect(await consuming).toMatchObject({ disposition: "stopped" });
		nextMessage.reject(new Error("late close failure"));
		await Promise.resolve();

		expect(errors).toContainEqual({
			message: "agent query failed while stopping",
			runId: undefined,
			error: "late close failure",
		});
	});

	it("does not log an expected AbortError from a clean interruption", async () => {
		const stopController = new AbortController();
		const nextMessage = Promise.withResolvers<IteratorResult<SDKMessage>>();
		const errors: Record<string, unknown>[] = [];
		const query: SupervisedQuery = {
			async interrupt() {
				nextMessage.reject(
					new DOMException("This operation was aborted", "AbortError"),
				);
			},
			close() {},
			[Symbol.asyncIterator]() {
				return { next: () => nextMessage.promise };
			},
		};
		const consuming = consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: stopController.signal,
			appendModelContents: async () => {},
			logger: {
				info() {},
				warn() {},
				error(fields) {
					errors.push(fields);
				},
			},
		});

		stopController.abort();

		expect(await consuming).toMatchObject({ disposition: "stopped" });
		expect(errors).toEqual([]);
	});

	it("prioritizes pre-observed ownership loss over regular stop", async () => {
		const stopController = new AbortController();
		const ownershipController = new AbortController();
		stopController.abort();
		ownershipController.abort();
		let interrupts = 0;
		let closes = 0;
		let deadlines = 0;
		const query: SupervisedQuery = {
			async interrupt() {
				interrupts++;
			},
			close() {
				closes++;
			},
			async *[Symbol.asyncIterator]() {
				yield resultMessage();
			},
		};

		const outcome = await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: stopController.signal,
			ownershipLostSignal: ownershipController.signal,
			appendModelContents: async () => {},
			startStopDeadline: () => {
				deadlines++;
				return { elapsed: new Promise(() => {}), cancel() {} };
			},
		});

		expect(outcome.disposition).toBe("stopped");
		expect({ interrupts, closes, deadlines }).toEqual({
			interrupts: 0,
			closes: 1,
			deadlines: 0,
		});
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

		const failure = await streamFailure(
			consumeAgentStream({
				abortRunScopedWork: noopRunScopeAbort,
				query,
				interruptionSignal: controller.signal,
				appendModelContents: onAssistantCommit((message) =>
					appended.push(message),
				),
			}),
		);
		expect(failure).toEqual(
			expect.objectContaining({
				message: expect.stringContaining("rate limited"),
			}),
		);
		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(0);
	});

	it("fails closed when a nominally successful stream ends before message_stop", async () => {
		const controller = new AbortController();
		const envelope = textEnvelope({ completeText: "uncommitted" });
		const query = fakeQuery(
			envelope.slice(0, 5).map((message) => ({ message })),
		);

		expect(
			await streamFailure(
				consumeAgentStream({
					abortRunScopedWork: noopRunScopeAbort,
					query,
					interruptionSignal: controller.signal,
					appendModelContents: async () => {},
				}),
			),
		).toBeInstanceOf(AssistantEnvelopeProtocolError);
	});

	it("fails closed when message_stop arrives before the envelope is complete", async () => {
		const envelope = textEnvelope({
			completeText: "uncommitted",
			partialText: "preview",
		});
		const query = fakeQuery([
			...envelope.slice(0, 3).map((message) => ({ message })),
			{ message: streamEvent({ type: "message_stop" }) },
		]);

		expect(
			await streamFailure(
				consumeAgentStream({
					abortRunScopedWork: noopRunScopeAbort,
					query,
					interruptionSignal: new AbortController().signal,
					appendModelContents: async () => {},
				}),
			),
		).toBeInstanceOf(AssistantEnvelopeProtocolError);
	});

	// Issue #244: a nominally successful stream with invalid envelope structure
	// fails closed. Each fixture is an otherwise-complete, well-boundaried
	// envelope whose only defect is a delta subtype that is structurally
	// impossible for its block type — so it must reject for the pairing itself,
	// not for a truncated stream.
	for (const fixture of [
		{
			name: "a thinking delta inside a tool_use block",
			block: { type: "tool_use", id: "toolu-1", name: "WebSearch", input: {} },
			delta: { type: "thinking_delta", thinking: "…" },
		},
		{
			name: "an input_json delta inside a thinking block",
			block: { type: "thinking", thinking: "", signature: "" },
			delta: { type: "input_json_delta", partial_json: "{}" },
		},
		{
			name: "a signature delta inside a tool_use block",
			block: { type: "tool_use", id: "toolu-1", name: "WebSearch", input: {} },
			delta: { type: "signature_delta", signature: "sig" },
		},
		{
			name: "a citations delta inside a text block",
			block: { type: "text", text: "" },
			delta: { type: "citations_delta", citation: {} },
		},
		{
			name: "a delta inside a delta-less redacted_thinking block",
			block: { type: "redacted_thinking", data: "opaque" },
			delta: { type: "thinking_delta", thinking: "…" },
		},
		{
			name: "a delta inside a delta-less web_search_tool_result block",
			block: {
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu-1",
				content: [],
			},
			delta: { type: "input_json_delta", partial_json: "{}" },
		},
	]) {
		it(`rejects ${fixture.name} as a protocol violation`, async () => {
			const appended: ModelContent[] = [];
			const query = fakeQuery(
				[
					streamEvent({
						type: "message_start",
						message: { id: "provider-1", content: [] },
					}),
					streamEvent({
						type: "content_block_start",
						index: 0,
						content_block: fixture.block,
					}),
					streamEvent({
						type: "content_block_delta",
						index: 0,
						delta: fixture.delta,
					}),
					assistantBlock("provider-1", fixture.block),
					streamEvent({ type: "content_block_stop", index: 0 }),
					streamEvent({ type: "message_stop" }),
				].map((message) => ({ message })),
			);

			expect(
				await streamFailure(
					consumeAgentStream({
						abortRunScopedWork: noopRunScopeAbort,
						query,
						interruptionSignal: new AbortController().signal,
						appendModelContents: captureModelContents(appended),
					}),
				),
			).toBeInstanceOf(AssistantEnvelopeProtocolError);
			expect(appended).toEqual([]);
		});
	}

	it("accepts protocol-valid thinking deltas and still commits the envelope's text", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const query = fakeQuery(
			[
				streamEvent({
					type: "message_start",
					message: { id: "provider-1", content: [] },
				}),
				streamEvent({
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "", signature: "" },
				}),
				streamEvent({
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "…" },
				}),
				streamEvent({
					type: "content_block_delta",
					index: 0,
					delta: { type: "signature_delta", signature: "sig" },
				}),
				assistantBlock("provider-1", {
					type: "thinking",
					thinking: "…",
					signature: "sig",
				}),
				streamEvent({ type: "content_block_stop", index: 0 }),
				streamEvent({
					type: "content_block_start",
					index: 1,
					content_block: { type: "text", text: "" },
				}),
				streamEvent({
					type: "content_block_delta",
					index: 1,
					delta: { type: "text_delta", text: "visible" },
				}),
				assistantBlock("provider-1", { type: "text", text: "visible" }),
				streamEvent({ type: "content_block_stop", index: 1 }),
				streamEvent({ type: "message_stop" }),
			].map((message) => ({ message })),
		);

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: new AbortController().signal,
			appendModelContents: onAssistantCommit((message) =>
				appended.push(message),
			),
		});

		expect(appended.map(({ text }) => text)).toEqual(["visible"]);
	});

	it("tolerates deltas inside an unknown block type as opaque content", async () => {
		const appended: Array<{ messageId: string; text: string }> = [];
		const query = fakeQuery(
			[
				streamEvent({
					type: "message_start",
					message: { id: "provider-1", content: [] },
				}),
				streamEvent({
					type: "content_block_start",
					index: 0,
					content_block: { type: "novel_block" },
				}),
				streamEvent({
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "…" },
				}),
				assistantBlock("provider-1", { type: "novel_block" }),
				streamEvent({ type: "content_block_stop", index: 0 }),
				streamEvent({
					type: "content_block_start",
					index: 1,
					content_block: { type: "text", text: "" },
				}),
				streamEvent({
					type: "content_block_delta",
					index: 1,
					delta: { type: "text_delta", text: "still committed" },
				}),
				assistantBlock("provider-1", { type: "text", text: "still committed" }),
				streamEvent({ type: "content_block_stop", index: 1 }),
				streamEvent({ type: "message_stop" }),
			].map((message) => ({ message })),
		);

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: new AbortController().signal,
			appendModelContents: onAssistantCommit((message) =>
				appended.push(message),
			),
		});

		expect(appended.map(({ text }) => text)).toEqual(["still committed"]);
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

		expect(
			await streamFailure(
				consumeAgentStream({
					abortRunScopedWork: noopRunScopeAbort,
					query,
					interruptionSignal: controller.signal,
					appendModelContents: async () => {},
				}),
			),
		).toBeInstanceOf(AgentResultError);
	});

	it("stops immediately on mirror error through the bounded stop path", async () => {
		const settled = deferred();
		const calls: string[] = [];
		let deadlineMs: number | undefined;
		let deadlineCancelled = false;
		const query: SupervisedQuery = {
			async interrupt() {
				calls.push("interrupt");
				settled.resolve();
			},
			close() {
				calls.push("close");
				settled.resolve();
			},
			async *[Symbol.asyncIterator]() {
				yield resultMessage("session-7");
				yield mirrorErrorMessage();
				await settled.promise;
			},
		};

		const outcome = await consumeAgentStream({
			query,
			interruptionSignal: new AbortController().signal,
			abortRunScopedWork: () => calls.push("tool-abort"),
			appendModelContents: async () => {},
			startStopDeadline: (timeoutMs) => {
				deadlineMs = timeoutMs;
				return {
					elapsed: new Promise(() => {}),
					cancel() {
						deadlineCancelled = true;
					},
				};
			},
		});

		expect(outcome).toEqual({
			disposition: "stopped",
			mirrorErrorObserved: true,
		});
		expect(calls).toEqual(["tool-abort", "interrupt"]);
		expect(deadlineMs).toBe(30_000);
		expect(deadlineCancelled).toBe(true);
	});

	for (const closeTrigger of ["deadline", "operational signal"] as const) {
		it(`retains ${closeTrigger} close detail while redacting the late mirror stream drain`, async () => {
			const deadlineElapsed = deferred();
			const forceCloseController = new AbortController();
			const nextRequested = deferred();
			const lateNext = Promise.withResolvers<IteratorResult<SDKMessage>>();
			const errors: Record<string, unknown>[] = [];
			let nextCalls = 0;
			const query: SupervisedQuery = {
				async interrupt() {},
				close() {
					throw new Error("operational close detail");
				},
				[Symbol.asyncIterator]() {
					return {
						next() {
							nextCalls++;
							if (nextCalls === 1) {
								return Promise.resolve({
									done: false,
									value: mirrorErrorMessage(),
								});
							}
							nextRequested.resolve();
							return lateNext.promise;
						},
					};
				},
			};
			const consuming = consumeAgentStream({
				runId: "run-1",
				query,
				interruptionSignal: new AbortController().signal,
				forceCloseSignals: [forceCloseController.signal],
				abortRunScopedWork: () => {},
				appendModelContents: async () => {},
				startStopDeadline: () => ({
					elapsed: deadlineElapsed.promise,
					cancel() {},
				}),
				logger: {
					info() {},
					warn() {},
					error(fields) {
						errors.push(fields);
					},
				},
			});
			await nextRequested.promise;

			if (closeTrigger === "deadline") deadlineElapsed.resolve();
			else forceCloseController.abort();
			expect(await consuming).toMatchObject({
				disposition: "stopped",
				mirrorErrorObserved: true,
			});
			lateNext.reject(new Error("provider stream drain detail"));
			await Promise.resolve();

			expect(errors).toEqual([
				{
					message: "agent query force-close failed",
					runId: "run-1",
					error: "operational close detail",
				},
				{
					message: "agent query failed while stopping",
					runId: "run-1",
				},
			]);
			expect(JSON.stringify(errors)).not.toContain(
				"provider stream drain detail",
			);
		});
	}

	it("redacts a mirror drain that began as an interruption", async () => {
		const interruptionController = new AbortController();
		interruptionController.abort();
		const errors: Record<string, unknown>[] = [];
		const outcome = await consumeAgentStream({
			runId: "run-1",
			query: fakeQuery([
				{ message: mirrorErrorMessage() },
				{ throw: new Error("interruption-first transcript detail") },
			]),
			interruptionSignal: interruptionController.signal,
			abortRunScopedWork: () => {},
			appendModelContents: async () => {},
			startStopDeadline: () => ({
				elapsed: new Promise(() => {}),
				cancel() {},
			}),
			logger: {
				info() {},
				warn() {},
				error(fields) {
					errors.push(fields);
				},
			},
		});

		expect(outcome).toMatchObject({
			disposition: "stopped",
			mirrorErrorObserved: true,
		});
		expect(errors).toEqual([
			{
				message: "agent query failed while stopping",
				runId: "run-1",
			},
		]);
		expect(JSON.stringify(errors)).not.toContain(
			"interruption-first transcript detail",
		);
	});

	it("appends text first, tool uses in block order, then results in block order", async () => {
		const appended: ModelContent[] = [];
		const { logger, warnings } = spyLogger();
		const messages = [
			...toolEnvelope({
				text: "Let me check.",
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "ls", cwd: "src", timeoutMs: 10_000 },
					},
					{
						toolUseId: "toolu-2",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "pwd" },
					},
				],
			}),
			toolResultUserMessage([
				{ toolUseId: "toolu-1", text: bashResultText({ stdout: "a.ts\n" }) },
				{
					toolUseId: "toolu-2",
					text: bashResultText({ stdout: "/workspace\n" }),
				},
			]),
			resultMessage("session-1"),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
			logger,
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
			"tool_call_result",
		]);
		expect(
			payloadsOfKind(appended, "tool_call_args").map(({ delta }) =>
				JSON.parse(delta),
			),
		).toEqual([
			{ command: "ls", cwd: "src", timeoutMs: 10_000 },
			{ command: "pwd" },
		]);
		expect(
			payloadsOfKind(appended, "tool_call_result").map(({ content }) =>
				JSON.parse(content),
			),
		).toEqual([
			{
				exitCode: 0,
				stdout: "a.ts\n",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				outcome: "completed",
			},
			{
				exitCode: 0,
				stdout: "/workspace\n",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				outcome: "completed",
			},
		]);
		expect(warnings).toEqual([]);
	});

	it("commits canonical Tool identities before publishing their live events", async () => {
		const appended: ModelContent[] = [];
		const liveEvents: Array<Record<string, unknown>> = [];
		const operations: string[] = [];
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "provider-tool-1",
						name: "mcp__mymemo-executor__Read",
						input: { path: "notes.md" },
					},
				],
			}),
			toolResultUserMessage([
				{
					toolUseId: "provider-tool-1",
					text: JSON.stringify({
						path: "notes.md",
						content: "hello",
						startLine: 1,
						linesRead: 1,
						truncated: false,
					}),
				},
			]),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: async (contents) => {
				appended.push(...contents);
				for (const content of contents) {
					operations.push(`durable:${content.kind}`);
				}
			},
			appendLiveEvent: async (event) => {
				liveEvents.push(event as unknown as Record<string, unknown>);
				operations.push(`live:${event.type}`);
			},
		});

		const durable = appended as unknown as Array<{
			kind: string;
			payload: Record<string, unknown>;
		}>;
		expect(durable.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
		]);
		const assistant = durable[0]?.payload;
		const started = durable[1]?.payload;
		const args = durable[2]?.payload;
		const completed = durable[3]?.payload;
		const result = durable[4]?.payload;
		expect(assistant).toMatchObject({ text: "" });
		expect(started).toMatchObject({
			toolCallName: "Read",
			parentMessageId: assistant?.messageId,
		});
		expect(started?.toolCallId).not.toBe("provider-tool-1");
		expect(assistant?.messageId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(started?.toolCallId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(args).toEqual({
			toolCallId: started?.toolCallId,
			delta: '{"path":"notes.md"}',
		});
		expect(completed).toEqual({ toolCallId: started?.toolCallId });
		expect(result).toMatchObject({
			toolCallId: started?.toolCallId,
			isError: false,
		});
		expect(liveEvents).toEqual([
			{
				type: EventType.TOOL_CALL_START,
				toolCallId: started?.toolCallId,
				toolCallName: "Read",
				parentMessageId: assistant?.messageId,
			},
			{
				type: EventType.TOOL_CALL_ARGS,
				toolCallId: started?.toolCallId,
				delta: '{"path":"notes.md"}',
			},
			{
				type: EventType.TOOL_CALL_END,
				toolCallId: started?.toolCallId,
			},
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: result?.messageId,
				toolCallId: started?.toolCallId,
				content: result?.content,
				role: "tool",
			},
		]);
		expect(operations).toEqual([
			"durable:assistant_message",
			"durable:tool_call_started",
			"durable:tool_call_args",
			"durable:tool_call_completed",
			`live:${EventType.TOOL_CALL_START}`,
			`live:${EventType.TOOL_CALL_ARGS}`,
			`live:${EventType.TOOL_CALL_END}`,
			"durable:tool_call_result",
			`live:${EventType.TOOL_CALL_RESULT}`,
		]);
	});

	it("streams a file-tool invocation and result end to end as guard-valid payloads", async () => {
		const appended: ModelContent[] = [];
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-edit-1",
						name: "mcp__mymemo-executor__Edit",
						input: {
							path: "src/app.ts",
							oldText: "const a",
							newText: "const alpha",
						},
					},
				],
			}),
			toolResultUserMessage([
				{
					toolUseId: "toolu-edit-1",
					text: JSON.stringify({ path: "src/app.ts", replacements: 2 }),
				},
			]),
			resultMessage("session-file-1"),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
		]);
		expect(
			JSON.parse(payloadsOfKind(appended, "tool_call_args")[0]?.delta ?? ""),
		).toEqual({
			path: "src/app.ts",
			oldText: "const a",
			oldTextBytes: 7,
			newText: "const alpha",
			newTextBytes: 11,
		});
		expect(
			JSON.parse(
				payloadsOfKind(appended, "tool_call_result")[0]?.content ?? "",
			),
		).toEqual({ path: "src/app.ts", replacements: 2 });
	});

	it("streams document-tool invocations and results as safe guard-valid payloads", async () => {
		const appended: ModelContent[] = [];
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-search-1",
						name: "mcp__mymemo-executor__SearchDocuments",
						input: {
							query: "quarterly roadmap",
							maxResults: 8,
							scope: "collection-secret",
						},
					},
					{
						toolUseId: "toolu-load-1",
						name: "mcp__mymemo-executor__LoadDocuments",
						input: {
							documentIds: ["document-good-secret", "document-bad-secret"],
						},
					},
				],
			}),
			toolResultUserMessage([
				{
					toolUseId: "toolu-search-1",
					text: JSON.stringify({
						passages: [
							{
								passageId: "passage-secret",
								documentId: "document-secret",
								title: "Q3 Roadmap",
								snippet: "Launch milestones",
							},
						],
					}),
				},
				{
					toolUseId: "toolu-load-1",
					text: JSON.stringify({
						loaded: [
							{
								documentId: "document-good-secret",
								title: "Q3 Roadmap",
								path: "/workspace/.mymemo/docs/document-good-secret.md",
								truncated: false,
							},
						],
						errors: [
							{
								documentId: "document-bad-secret",
								error: "scope collection-secret denied",
							},
						],
					}),
				},
			]),
			resultMessage("session-documents-1"),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
			"tool_call_result",
		]);
		expect(
			payloadsOfKind(appended, "tool_call_args").map(({ delta }) =>
				JSON.parse(delta),
			),
		).toEqual([{ query: "quarterly roadmap" }, { requestedCount: 2 }]);
		expect(
			payloadsOfKind(appended, "tool_call_result").map(({ content }) =>
				JSON.parse(content),
			),
		).toEqual([
			{ passages: [{ title: "Q3 Roadmap", snippet: "Launch milestones" }] },
			{
				loadedCount: 1,
				loaded: [{ title: "Q3 Roadmap" }],
				failedCount: 1,
				failureSummary: "Some documents could not be loaded",
			},
		]);
	});

	it("appends only ordered tool uses for a textless envelope", async () => {
		const appended: ModelContent[] = [];
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "true" },
					},
				],
			}),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
		]);
	});

	it("appends no tool event before message_stop commits the envelope", async () => {
		const appended: ModelContent[] = [];
		const envelope = toolEnvelope({
			toolUses: [
				{
					toolUseId: "toolu-1",
					name: "mcp__mymemo-executor__Bash",
					input: { command: "ls" },
				},
			],
		});
		const query = fakeQuery([
			...envelope.slice(0, -1).map((message) => ({ message })),
			{
				message: messageAt(envelope, envelope.length - 1),
				before: () => expect(appended).toEqual([]),
			},
		]);

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
		]);
	});

	it("ignores replay-flagged user messages entirely", async () => {
		const appended: ModelContent[] = [];
		const { logger, warnings } = spyLogger();
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "ls" },
					},
				],
			}),
			toolResultUserMessage(
				[{ toolUseId: "toolu-1", text: bashResultText({}) }],
				{ isReplay: true },
			),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
			logger,
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
		]);
		expect(warnings).toEqual([]);
	});

	it("omits and logs a result naming an unknown tool-use id", async () => {
		const appended: ModelContent[] = [];
		const { logger, warnings } = spyLogger();
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "ls" },
					},
				],
			}),
			toolResultUserMessage([
				{ toolUseId: "toolu-unseen", text: bashResultText({}) },
			]),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			runId: "run-1",
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
			logger,
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ toolUseId: "toolu-unseen" });
	});

	it("omits and logs a second result for an already-matched id", async () => {
		const appended: ModelContent[] = [];
		const { logger, warnings } = spyLogger();
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "ls" },
					},
				],
			}),
			toolResultUserMessage([
				{ toolUseId: "toolu-1", text: bashResultText({}) },
			]),
			toolResultUserMessage([
				{ toolUseId: "toolu-1", text: bashResultText({}) },
			]),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
			logger,
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
			"tool_call_result",
		]);
		expect(warnings).toHaveLength(1);
	});

	it("omits and logs a non-allowlisted tool and its orphaned result", async () => {
		const appended: ModelContent[] = [];
		const { logger, warnings } = spyLogger();
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__other-server__Bash",
						input: { command: "ls" },
					},
				],
			}),
			toolResultUserMessage([
				{ toolUseId: "toolu-1", text: bashResultText({}) },
			]),
			resultMessage(),
		];

		const outcome = await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
			logger,
		});

		// The run continues and completes; visibility degrades, correctness does not.
		expect(outcome.mirrorErrorObserved).toBe(false);
		expect(appended).toEqual([]);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatchObject({ toolName: "mcp__other-server__Bash" });
		expect(warnings[1]).toMatchObject({ toolUseId: "toolu-1" });
	});

	it("projects an error-flagged result as the fixed safe message", async () => {
		const appended: ModelContent[] = [];
		const liveEvents: Array<Record<string, unknown>> = [];
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "ls" },
					},
				],
			}),
			toolResultUserMessage([
				{
					toolUseId: "toolu-1",
					text: "Bash failed: connect ECONNREFUSED 10.0.0.7:5432",
					isError: true,
				},
			]),
		];

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
			appendLiveEvent: async (event) => {
				liveEvents.push(event as unknown as Record<string, unknown>);
			},
		});

		const [result] = payloadsOfKind(appended, "tool_call_result");
		expect(result).toEqual(
			expect.objectContaining({
				content: "Tool failed",
				isError: true,
			}),
		);
		expect(liveEvents.slice(-2)).toEqual([
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: result?.messageId,
				toolCallId: result?.toolCallId,
				content: "Tool failed",
				role: "tool",
			},
			{
				type: EventType.CUSTOM,
				name: "mymemo.tool_result_error",
				value: {
					messageId: result?.messageId,
					toolCallId: result?.toolCallId,
				},
			},
		]);
	});

	it("discards buffered tool blocks when the envelope is abandoned by abort", async () => {
		const appended: ModelContent[] = [];
		const controller = new AbortController();
		const envelope = toolEnvelope({
			toolUses: [
				{
					toolUseId: "toolu-1",
					name: "mcp__mymemo-executor__Bash",
					input: { command: "ls" },
				},
			],
		});
		// Abort while the tool block is complete but the envelope is still open.
		const query = fakeQuery([
			...envelope.slice(0, -1).map((message) => ({ message })),
			{
				message: messageAt(envelope, envelope.length - 1),
				before: () => controller.abort(),
			},
		]);

		const outcome = await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: controller.signal,
			appendModelContents: captureModelContents(appended),
		});

		expect(outcome.disposition).toBe("stopped");
		expect(appended).toEqual([]);
	});

	it("appends no tool result after the run is aborted", async () => {
		const appended: ModelContent[] = [];
		const controller = new AbortController();
		const envelope = toolEnvelope({
			toolUses: [
				{
					toolUseId: "toolu-1",
					name: "mcp__mymemo-executor__Bash",
					input: { command: "ls" },
				},
			],
		});
		const query = fakeQuery([
			...envelope.map((message) => ({ message })),
			{
				message: toolResultUserMessage([
					{ toolUseId: "toolu-1", text: bashResultText({}) },
				]),
				before: () => controller.abort(),
			},
		]);

		const outcome = await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: controller.signal,
			appendModelContents: captureModelContents(appended),
		});

		expect(outcome.disposition).toBe("stopped");
		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
		]);
	});

	it("stops appending tool events when supervised stop aborts a stalled append", async () => {
		const appended: ModelContent[] = [];
		const controller = new AbortController();
		let markAppendStarted!: () => void;
		const appendStarted = new Promise<void>((resolve) => {
			markAppendStarted = resolve;
		});
		let releaseAppend!: () => void;
		const appendGate = new Promise<void>((resolve) => {
			releaseAppend = resolve;
		});
		const messages = toolEnvelope({
			toolUses: [
				{
					toolUseId: "toolu-1",
					name: "mcp__mymemo-executor__Bash",
					input: { command: "first" },
				},
				{
					toolUseId: "toolu-2",
					name: "mcp__mymemo-executor__Bash",
					input: { command: "second" },
				},
			],
		});
		const query = fakeQuery(messages.map((message) => ({ message })));

		const consuming = consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query,
			interruptionSignal: controller.signal,
			appendModelContents: async (contents) => {
				appended.push(...contents);
				if (appended.length === 1) {
					markAppendStarted();
					await appendGate;
				}
			},
		});

		await appendStarted;
		controller.abort();
		releaseAppend();

		expect((await consuming).disposition).toBe("stopped");
		expect(query.interrupts).toBe(1);
		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
		]);
	});

	it("logs and omits a tool invocation with malformed required arguments", async () => {
		const appended: ModelContent[] = [];
		const { logger, warnings } = spyLogger();
		const messages = toolEnvelope({
			toolUses: [
				{
					toolUseId: "toolu-1",
					name: "mcp__mymemo-executor__Bash",
					input: { command: 42 },
				},
			],
		});

		await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			runId: "run-1",
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
			logger,
		});

		expect(appended).toEqual([]);
		expect(warnings).toEqual([
			expect.objectContaining({
				message: "tool invocation omitted",
				runId: "run-1",
				tool: "Bash",
			}),
		]);
	});

	it("leaves the history resultless when the stream ends without a result", async () => {
		const appended: ModelContent[] = [];
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "sleep 600" },
					},
				],
			}),
			resultMessage("session-1"),
		];

		const outcome = await consumeAgentStream({
			abortRunScopedWork: noopRunScopeAbort,
			query: fakeQuery(messages.map((message) => ({ message }))),
			interruptionSignal: new AbortController().signal,
			appendModelContents: captureModelContents(appended),
		});

		// No result is ever fabricated; the supervisor's terminal frame closes the
		// stream after the resultless invocation.
		expect(appended.map((content) => content.kind)).toEqual([
			"assistant_message",
			"tool_call_started",
			"tool_call_args",
			"tool_call_completed",
		]);
		expect(outcome).toEqual({
			disposition: "completed",
			mirrorErrorObserved: false,
		});
	});

	it("propagates a failed tool-use append so the run terminalizes error", async () => {
		const boom = new Error("append rejected by fence");
		const messages = toolEnvelope({
			toolUses: [
				{
					toolUseId: "toolu-1",
					name: "mcp__mymemo-executor__Bash",
					input: { command: "ls" },
				},
			],
		});

		expect(
			await streamFailure(
				consumeAgentStream({
					abortRunScopedWork: noopRunScopeAbort,
					query: fakeQuery(messages.map((message) => ({ message }))),
					interruptionSignal: new AbortController().signal,
					appendModelContents: async (contents) => {
						if (contents.some(({ kind }) => kind === "tool_call_started")) {
							throw boom;
						}
					},
				}),
			),
		).toBe(boom);
	});

	it("propagates a failed tool-result append so the run terminalizes error", async () => {
		const boom = new Error("append rejected by fence");
		const messages = [
			...toolEnvelope({
				toolUses: [
					{
						toolUseId: "toolu-1",
						name: "mcp__mymemo-executor__Bash",
						input: { command: "ls" },
					},
				],
			}),
			toolResultUserMessage([
				{ toolUseId: "toolu-1", text: bashResultText({}) },
			]),
		];

		expect(
			await streamFailure(
				consumeAgentStream({
					abortRunScopedWork: noopRunScopeAbort,
					query: fakeQuery(messages.map((message) => ({ message }))),
					interruptionSignal: new AbortController().signal,
					appendModelContents: async (contents) => {
						if (contents.some(({ kind }) => kind === "tool_call_result")) {
							throw boom;
						}
					},
				}),
			),
		).toBe(boom);
	});

	it("rejects a completed tool_use block without an id or name as a protocol violation", async () => {
		const providerMessageId = "provider-message-1";
		const messages = [
			streamEvent({
				type: "message_start",
				message: { id: providerMessageId, content: [] },
			}),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu-1",
					name: "x",
					input: {},
				},
			}),
			assistantBlock(providerMessageId, { type: "tool_use", input: {} }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		];

		expect(
			await streamFailure(
				consumeAgentStream({
					abortRunScopedWork: noopRunScopeAbort,
					query: fakeQuery(messages.map((message) => ({ message }))),
					interruptionSignal: new AbortController().signal,
					appendModelContents: async () => {},
				}),
			),
		).toBeInstanceOf(AssistantEnvelopeProtocolError);
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

		expect(
			await streamFailure(
				consumeAgentStream({
					abortRunScopedWork: noopRunScopeAbort,
					query,
					interruptionSignal: controller.signal,
					appendModelContents: onAssistantCommit((message) =>
						appended.push(message),
					),
				}),
			),
		).toBe(boom);
		expect(appended).toEqual([]);
		expect(query.interrupts).toBe(0);
	});
});
