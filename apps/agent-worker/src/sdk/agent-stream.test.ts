import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	isToolResultPayload,
	isToolUsePayload,
} from "@mymemo/agent-db/run-events";
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

/** Record every model-content append, whatever its kind, in stream order. */
function captureModelContent(
	appended: ModelContent[],
): (content: ModelContent) => Promise<void> {
	return async (content) => {
		appended.push(content);
	};
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
			logger,
		});

		expect(
			appended.map((content) =>
				content.kind === "assistant_message"
					? content.kind
					: `${content.kind}:${JSON.stringify(
							content.kind === "tool_use"
								? content.payload.arguments.command
								: content.payload.result.stdout,
						)}`,
			),
		).toEqual([
			"assistant_message",
			'tool_use:"ls"',
			'tool_use:"pwd"',
			'tool_result:"a.ts\\n"',
			'tool_result:"/workspace\\n"',
		]);
		expect(appended[1]).toEqual({
			kind: "tool_use",
			payload: {
				tool: "Bash",
				arguments: { command: "ls", cwd: "src", timeoutMs: 10_000 },
				truncated: false,
			},
		});
		expect(appended[3]).toEqual({
			kind: "tool_result",
			payload: {
				tool: "Bash",
				result: {
					exitCode: 0,
					stdout: "a.ts\n",
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					outcome: "completed",
				},
				isError: false,
				truncated: false,
			},
		});
		expect(warnings).toEqual([]);
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
		});

		expect(appended).toEqual([
			{
				kind: "tool_use",
				payload: {
					tool: "Edit",
					arguments: {
						path: "src/app.ts",
						oldText: "const a",
						oldTextBytes: 7,
						newText: "const alpha",
						newTextBytes: 11,
					},
					truncated: false,
				},
			},
			{
				kind: "tool_result",
				payload: {
					tool: "Edit",
					result: { path: "src/app.ts", replacements: 2 },
					isError: false,
					truncated: false,
				},
			},
		]);
		// Guard-valid means chat-api's projector will map these durable payloads
		// to the tool_use/tool_result client frames (the tracer's projector cases).
		const [use, result] = appended;
		if (use?.kind !== "tool_use" || result?.kind !== "tool_result") {
			throw new Error("expected a tool_use then a tool_result");
		}
		expect(isToolUsePayload(use.payload)).toBe(true);
		expect(isToolResultPayload(result.payload)).toBe(true);
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
		});

		expect(appended).toEqual([
			{
				kind: "tool_use",
				payload: {
					tool: "SearchDocuments",
					arguments: { query: "quarterly roadmap" },
					truncated: false,
				},
			},
			{
				kind: "tool_use",
				payload: {
					tool: "LoadDocuments",
					arguments: { requestedCount: 2 },
					truncated: false,
				},
			},
			{
				kind: "tool_result",
				payload: {
					tool: "SearchDocuments",
					result: {
						passages: [{ title: "Q3 Roadmap", snippet: "Launch milestones" }],
					},
					isError: false,
					truncated: false,
				},
			},
			{
				kind: "tool_result",
				payload: {
					tool: "LoadDocuments",
					result: {
						loadedCount: 1,
						loaded: [{ title: "Q3 Roadmap" }],
						failedCount: 1,
						failureSummary: "Some documents could not be loaded",
					},
					isError: false,
					truncated: false,
				},
			},
		]);
		for (const content of appended) {
			if (content.kind === "tool_use") {
				expect(isToolUsePayload(content.payload)).toBe(true);
			} else if (content.kind === "tool_result") {
				expect(isToolResultPayload(content.payload)).toBe(true);
			}
		}
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
		});

		expect(appended.map((content) => content.kind)).toEqual(["tool_use"]);
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
			query,
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
		});

		expect(appended.map((content) => content.kind)).toEqual(["tool_use"]);
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
			logger,
		});

		expect(appended.map((content) => content.kind)).toEqual(["tool_use"]);
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
			runId: "run-1",
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
			logger,
		});

		expect(appended.map((content) => content.kind)).toEqual(["tool_use"]);
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
			logger,
		});

		expect(appended.map((content) => content.kind)).toEqual([
			"tool_use",
			"tool_result",
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
		});

		expect(appended[1]).toEqual({
			kind: "tool_result",
			payload: {
				tool: "Bash",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			},
		});
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

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: captureModelContent(appended),
			}),
		).rejects.toBeInstanceOf(QueryInterruptedError);

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

		await expect(
			consumeAgentStream({
				query,
				signal: controller.signal,
				appendModelContent: captureModelContent(appended),
			}),
		).rejects.toBeInstanceOf(QueryInterruptedError);

		expect(appended.map((content) => content.kind)).toEqual(["tool_use"]);
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
			query: fakeQuery(messages.map((message) => ({ message }))),
			signal: new AbortController().signal,
			appendModelContent: captureModelContent(appended),
		});

		// No result is ever fabricated; the supervisor's terminal frame closes the
		// stream after the resultless invocation.
		expect(appended.map((content) => content.kind)).toEqual(["tool_use"]);
		expect(outcome.sessionId).toBe("session-1");
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

		await expect(
			consumeAgentStream({
				query: fakeQuery(messages.map((message) => ({ message }))),
				signal: new AbortController().signal,
				appendModelContent: async (content) => {
					if (content.kind === "tool_use") throw boom;
				},
			}),
		).rejects.toBe(boom);
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

		await expect(
			consumeAgentStream({
				query: fakeQuery(messages.map((message) => ({ message }))),
				signal: new AbortController().signal,
				appendModelContent: async (content) => {
					if (content.kind === "tool_result") throw boom;
				},
			}),
		).rejects.toBe(boom);
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

		await expect(
			consumeAgentStream({
				query: fakeQuery(messages.map((message) => ({ message }))),
				signal: new AbortController().signal,
				appendModelContent: async () => {},
			}),
		).rejects.toBeInstanceOf(AssistantEnvelopeProtocolError);
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
