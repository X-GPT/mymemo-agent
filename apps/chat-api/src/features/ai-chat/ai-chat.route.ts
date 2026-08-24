import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sValidator as zValidator } from "@hono/standard-validator";
import {
	isTerminalRunStatus,
	RunInputMismatchError,
	type RunRecord,
} from "@mymemo/agent-db/run-store";
import {
	decodeAgUiLiveStreamEvent,
	RUN_INTERRUPTED_EVENT_TYPE,
} from "@mymemo/live-text";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	safeValidateUIMessages,
	type UIMessageStreamWriter,
} from "ai";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppDeps, AppEnv } from "@/deps";
import {
	ConversationIdParam,
	MAX_REQUEST_BODY_BYTES,
	RunIdParam,
} from "@/features/conversations/conversations.schema";
import { requireInternalIdentity } from "@/features/conversations/internal-identity";
import type { ExposureGate } from "@/features/exposure-gate";
import {
	ActiveRunExistsError,
	ConversationArchivedError,
	ConversationNotFoundError,
} from "@/features/run-store/run-store";
import type { AgentRuntimeInvoker } from "./agent-query";
import type { ChatMessage, ChatMessageStore } from "./chat-message-store";

const app = new Hono<AppEnv>();
const MAX_MESSAGE_LENGTH = 50_000;
export const AI_CHAT_MODELS = ["anthropic/claude-sonnet-5"] as const;

const AiChatBody = z.strictObject({
	id: ConversationIdParam,
	messages: z.unknown(),
	trigger: z.literal("submit-message"),
});

const QueryTextPart = z.strictObject({
	type: z.literal("text"),
	text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
});
const QueryUserMessage = z.strictObject({
	id: RunIdParam,
	role: z.literal("user"),
	parts: z.tuple([QueryTextPart]),
});
const AgentQueryChatBody = z.strictObject({
	id: ConversationIdParam,
	messages: z.tuple([QueryUserMessage]),
	model: z.string(),
	trigger: z.literal("submit-message"),
});

export interface AgentQueryChatDeps {
	messageStore: ChatMessageStore;
	runtimeInvoker: AgentRuntimeInvoker;
	exposureGate: ExposureGate;
	createMessageId?: () => string;
}

async function waitForRunEvents(
	deps: AppDeps,
	run: RunRecord,
	signal: AbortSignal,
) {
	for (;;) {
		const attached = await deps.liveStreamRelay.attach(run.runId, signal);
		if (attached.outcome === "attached") return attached;
		if (attached.outcome !== "no_producer") {
			throw new Error("Live stream unavailable");
		}

		const current = await deps.runStore.getRun({
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
		});
		if (!current) throw new Error("Run not found");
		if (isTerminalRunStatus(current.status)) {
			return { outcome: "terminal" as const, status: current.status };
		}
		if (current.liveStreamFailedAt) {
			throw new Error("Live stream unavailable");
		}
	}
}

async function writeAiMessageStream(
	writer: UIMessageStreamWriter,
	events: AsyncIterable<Uint8Array>,
) {
	let messageStarted = false;
	for await (const chunk of events) {
		const event = decodeAgUiLiveStreamEvent(chunk);
		switch (event.type) {
			case EventType.TEXT_MESSAGE_START:
				if (!messageStarted) {
					writer.write({ type: "start", messageId: event.messageId });
					messageStarted = true;
				}
				writer.write({ type: "text-start", id: event.messageId });
				break;
			case EventType.TEXT_MESSAGE_CONTENT:
				writer.write({
					type: "text-delta",
					id: event.messageId,
					delta: event.delta,
				});
				break;
			case EventType.TEXT_MESSAGE_END:
				writer.write({ type: "text-end", id: event.messageId });
				break;
			case EventType.RUN_FINISHED:
				writer.write({ type: "finish", finishReason: "stop" });
				return;
			case EventType.RUN_ERROR:
				writer.write({ type: "error", errorText: "Run failed" });
				writer.write({ type: "finish", finishReason: "error" });
				return;
			case RUN_INTERRUPTED_EVENT_TYPE:
				writer.write({ type: "abort" });
				return;
		}
	}
}

app.post(
	"/",
	bodyLimit({
		maxSize: MAX_REQUEST_BODY_BYTES,
		onError: (c) => c.json({ error: "Request body too large" }, 413),
	}),
	zValidator("json", AiChatBody, (result, c) => {
		if (!result.success)
			return c.json({ error: "Invalid AI SDK chat input" }, 400);
	}),
	requireInternalIdentity,
	async (c) => {
		const body = c.req.valid("json");
		const validated = await safeValidateUIMessages({ messages: body.messages });
		const finalMessage = validated.success ? validated.data.at(-1) : undefined;
		const part = finalMessage?.parts[0];
		if (
			finalMessage?.role !== "user" ||
			finalMessage.parts.length !== 1 ||
			part?.type !== "text" ||
			!RunIdParam.safeParse(finalMessage.id).success ||
			part.text.length === 0 ||
			part.text.length > MAX_MESSAGE_LENGTH
		) {
			return c.json({ error: "Final message must contain only text" }, 400);
		}

		const conversation = await c.var.deps.conversationStore.get({
			userId: c.var.identity.memberCode,
			conversationId: body.id,
		});
		if (!conversation) return c.json({ error: "Conversation not found" }, 404);

		if (!(await c.var.deps.exposureGate.isAgentEnabled(c.var.identity))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}

		let run: RunRecord;
		try {
			const admission = await c.var.deps.runStore.admitRun({
				conversation,
				runId: finalMessage.id,
				messageId: finalMessage.id,
				message: part.text,
			});
			if (admission.outcome === "not_found") {
				return c.json({ error: "Run not found" }, 404);
			}
			run = admission.run;
		} catch (error) {
			if (error instanceof ActiveRunExistsError) {
				return c.json({ error: "Conversation already has an active Run" }, 409);
			}
			if (error instanceof RunInputMismatchError) {
				return c.json(
					{ error: "Message id was reused with different input" },
					409,
				);
			}
			if (error instanceof ConversationArchivedError) {
				return c.json({ error: "Conversation is archived" }, 409);
			}
			if (error instanceof ConversationNotFoundError) {
				return c.json({ error: "Conversation not found" }, 404);
			}
			throw error;
		}

		const stream = createUIMessageStream({
			async execute({ writer }) {
				const source = await waitForRunEvents(
					c.var.deps,
					run,
					c.req.raw.signal,
				);
				if (source.outcome === "attached") {
					await writeAiMessageStream(writer, source.events);
					return;
				}
				switch (source.status) {
					case "done":
						writer.write({
							type: "error",
							errorText: "Live response unavailable",
						});
						writer.write({ type: "finish", finishReason: "error" });
						break;
					case "error":
						writer.write({ type: "error", errorText: "Run failed" });
						writer.write({ type: "finish", finishReason: "error" });
						break;
					case "interrupted":
						writer.write({ type: "abort" });
						break;
				}
			},
		});
		return createUIMessageStreamResponse({ stream });
	},
);

class ClaudeTranslationError extends Error {}

async function writeClaudeMessageStream(
	writer: UIMessageStreamWriter,
	events: AsyncIterable<SDKMessage> | Iterable<SDKMessage>,
	messageId: string,
): Promise<string> {
	const textPartId = `${messageId}-text`;
	let text = "";
	let messageStarted = false;
	let messageStopped = false;
	let textOpen = false;
	let textClosed = false;
	let terminal = false;
	writer.write({ type: "start", messageId });

	for await (const value of events) {
		const message = value;
		if (message?.type === "result") {
			if (
				terminal ||
				message.subtype !== "success" ||
				message.is_error ||
				typeof message.session_id !== "string" ||
				message.session_id.length === 0 ||
				!messageStopped
			) {
				throw new ClaudeTranslationError("invalid terminal Claude result");
			}
			terminal = true;
			continue;
		}
		if (message?.type !== "stream_event" || terminal) {
			throw new ClaudeTranslationError("invalid Claude event");
		}

		const event = message.event;
		switch (event.type) {
			case "message_start":
				if (messageStarted || event.message.id.length === 0) {
					throw new ClaudeTranslationError("invalid Claude message start");
				}
				messageStarted = true;
				break;
			case "message_stop":
				if (!messageStarted || !textClosed || messageStopped) {
					throw new ClaudeTranslationError("invalid Claude message stop");
				}
				messageStopped = true;
				break;
			case "content_block_start":
				if (
					!messageStarted ||
					messageStopped ||
					event.index !== 0 ||
					event.content_block.type !== "text" ||
					textOpen ||
					textClosed
				) {
					throw new ClaudeTranslationError("unsupported Claude content block");
				}
				textOpen = true;
				writer.write({ type: "text-start", id: textPartId });
				break;
			case "content_block_delta":
				if (
					event.index !== 0 ||
					event.delta.type !== "text_delta" ||
					typeof event.delta.text !== "string" ||
					!textOpen
				) {
					throw new ClaudeTranslationError("invalid Claude text delta");
				}
				text += event.delta.text;
				writer.write({
					type: "text-delta",
					id: textPartId,
					delta: event.delta.text,
				});
				break;
			case "content_block_stop":
				if (event.index !== 0 || !textOpen) {
					throw new ClaudeTranslationError("invalid Claude text end");
				}
				textOpen = false;
				textClosed = true;
				writer.write({ type: "text-end", id: textPartId });
				break;
			default:
				throw new ClaudeTranslationError("unsupported Claude event");
		}
	}

	if (!terminal || !messageStopped || text.length === 0) {
		throw new ClaudeTranslationError("Claude stream ended before completion");
	}
	return text;
}

function createAgentQueryApp(deps: AgentQueryChatDeps) {
	const queryApp = new Hono<AppEnv>();
	queryApp.post(
		"/",
		bodyLimit({
			maxSize: MAX_REQUEST_BODY_BYTES,
			onError: (c) => c.json({ error: "Request body too large" }, 413),
		}),
		zValidator("json", AgentQueryChatBody, (result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid AI SDK chat input" }, 400);
			}
		}),
		requireInternalIdentity,
		async (c) => {
			const body = c.req.valid("json");
			if (!(AI_CHAT_MODELS as readonly string[]).includes(body.model)) {
				return c.json({ error: "Unsupported model" }, 400);
			}
			const ref = {
				userId: c.var.identity.memberCode,
				conversationId: body.id,
			};
			if (!(await deps.messageStore.ownedConversationExists(ref))) {
				return c.json({ error: "Conversation not found" }, 404);
			}
			if (!(await deps.exposureGate.isAgentEnabled(c.var.identity))) {
				return c.json({ error: "Agent is not enabled" }, 403);
			}

			const userMessage = body.messages[0] as ChatMessage;
			const admission = await deps.messageStore.admitUserMessage(
				ref,
				userMessage,
			);
			switch (admission.outcome) {
				case "not_found":
					return c.json({ error: "Conversation not found" }, 404);
				case "archived":
					return c.json({ error: "Conversation is archived" }, 409);
				case "duplicate":
					return c.json({ error: "Message id was already used" }, 409);
			}

			const assistantMessageId = (deps.createMessageId ?? randomUUID)();
			const stream = createUIMessageStream({
				onError: () => "Response failed",
				async execute({ writer }) {
					const events = await deps.runtimeInvoker.invoke({
						version: 1,
						conversationId: body.id,
						conversationEpoch: admission.conversationEpoch,
						prompt: body.messages[0].parts[0].text,
						model: body.model,
					});
					const text = await writeClaudeMessageStream(
						writer,
						events,
						assistantMessageId,
					);
					await deps.messageStore.persistAssistantMessage(ref, {
						id: assistantMessageId,
						role: "assistant",
						parts: [{ type: "text", text }],
					});
					writer.write({ type: "finish", finishReason: "stop" });
				},
			});
			return createUIMessageStreamResponse({ stream });
		},
	);
	return queryApp;
}

/**
 * The injected Agent-query seam exercises the replacement behavior without
 * selecting it in production composition. The default remains the Run-backed
 * route until the hard-swap issue changes the composition root.
 */
export function createAiChatRoutes(queryDeps?: AgentQueryChatDeps) {
	return queryDeps ? createAgentQueryApp(queryDeps) : app;
}

export default createAiChatRoutes();
