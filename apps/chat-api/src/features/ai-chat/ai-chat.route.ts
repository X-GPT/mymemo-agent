import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sValidator as zValidator } from "@hono/standard-validator";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessageStreamWriter,
} from "ai";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import {
	ConversationIdParam,
	MAX_REQUEST_BODY_BYTES,
	RunIdParam,
} from "@/features/conversations/conversations.schema";
import { requireInternalIdentity } from "@/features/conversations/internal-identity";
import type { ExposureGate } from "@/features/exposure-gate";
import type {
	ChatMessage,
	PostgresChatMessageStore,
} from "./postgres-chat-message-store";

const MAX_MESSAGE_LENGTH = 50_000;
export const AI_CHAT_MODELS = ["anthropic/claude-sonnet-5"] as const;

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

export type AgentQueryChatDeps = {
	messageStore: Pick<
		PostgresChatMessageStore,
		| "ownedConversationExists"
		| "admitUserMessage"
		| "persistAssistantMessageAndSession"
	>;
	runtimeInvoker: {
		invoke(
			request: AgentQueryRequest,
		): Promise<AsyncIterable<SDKMessage> | Iterable<SDKMessage>>;
	};
	exposureGate: ExposureGate;
	createMessageId?: () => string;
};

async function writeClaudeMessageStream(
	writer: UIMessageStreamWriter<ChatMessage>,
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
	let agentSessionId: string | undefined;
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
				throw new Error("invalid terminal Claude result");
			}
			terminal = true;
			agentSessionId = message.session_id;
			continue;
		}
		if (message?.type !== "stream_event" || terminal) {
			throw new Error("invalid Claude event");
		}

		const event = message.event;
		switch (event.type) {
			case "message_start":
				if (messageStarted || event.message.id.length === 0) {
					throw new Error("invalid Claude message start");
				}
				messageStarted = true;
				break;
			case "message_stop":
				if (!messageStarted || !textClosed || messageStopped) {
					throw new Error("invalid Claude message stop");
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
					throw new Error("unsupported Claude content block");
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
					throw new Error("invalid Claude text delta");
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
					throw new Error("invalid Claude text end");
				}
				textOpen = false;
				textClosed = true;
				writer.write({ type: "text-end", id: textPartId });
				break;
			default:
				throw new Error("unsupported Claude event");
		}
	}

	if (!terminal || !agentSessionId || !messageStopped || text.length === 0) {
		throw new Error("Claude stream ended before completion");
	}
	return agentSessionId;
}

async function handleAgentQueryChat(
	c: Context<AppEnv>,
	body: z.infer<typeof AgentQueryChatBody>,
	deps: AgentQueryChatDeps,
) {
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
	const admission = await deps.messageStore.admitUserMessage(ref, userMessage);
	switch (admission.outcome) {
		case "not_found":
			return c.json({ error: "Conversation not found" }, 404);
		case "archived":
			return c.json({ error: "Conversation is archived" }, 409);
		case "duplicate":
			return c.json({ error: "Message id was already used" }, 409);
	}

	const assistantMessageId = (deps.createMessageId ?? randomUUID)();
	let agentSessionId: string | undefined;
	const stream = createUIMessageStream<ChatMessage>({
		onError: () => "Response failed",
		async onEnd({ finishReason, isAborted, responseMessage }) {
			if (finishReason !== "stop" || isAborted) return;
			if (!agentSessionId) throw new Error("Agent session was not completed");
			await deps.messageStore.persistAssistantMessageAndSession(
				ref,
				responseMessage,
				agentSessionId,
			);
		},
		async execute({ writer }) {
			const events = await deps.runtimeInvoker.invoke({
				version: 1,
				conversationId: body.id,
				conversationEpoch: admission.conversationEpoch,
				prompt: body.messages[0].parts[0].text,
				model: body.model,
				...(admission.agentSessionId
					? { agentSessionId: admission.agentSessionId }
					: {}),
			});
			agentSessionId = await writeClaudeMessageStream(
				writer,
				events,
				assistantMessageId,
			);
			writer.write({ type: "finish", finishReason: "stop" });
		},
	});
	return createUIMessageStreamResponse({ stream });
}

export function createAiChatRoutes(queryDeps: AgentQueryChatDeps) {
	const routes = new Hono<AppEnv>();
	routes.post(
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
		(c) => handleAgentQueryChat(c, c.req.valid("json"), queryDeps),
	);
	return routes;
}
