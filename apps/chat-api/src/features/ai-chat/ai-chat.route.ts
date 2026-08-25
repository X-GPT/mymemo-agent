import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sValidator as zValidator } from "@hono/standard-validator";
import type { PublicToolName } from "@mymemo/agent-db/run-events";
import {
	projectToolResult,
	projectToolUse,
	publicToolName,
} from "@mymemo/agent-db/tool-event-projection";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessage,
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

export type AgentQueryRuntimeInvoker = {
	invoke(
		request: AgentQueryRequest,
	): Promise<AsyncIterable<SDKMessage> | Iterable<SDKMessage>>;
};

async function writeClaudeMessageStream(
	writer: UIMessageStreamWriter<UIMessage>,
	events: AsyncIterable<SDKMessage> | Iterable<SDKMessage>,
	messageId: string,
): Promise<string> {
	let textPartIndex = 0;
	let wrotePart = false;
	let messageOpen = false;
	let textIndex: number | undefined;
	let textId: string | undefined;
	let terminal = false;
	let agentSessionId: string | undefined;
	const toolInvocations = new Map<
		string,
		{ tool: PublicToolName; toolCallId: string }
	>();
	writer.write({ type: "start", messageId });

	for await (const message of events) {
		if (message.type === "result") {
			if (
				terminal ||
				message.subtype !== "success" ||
				message.is_error ||
				typeof message.session_id !== "string" ||
				message.session_id.length === 0
			) {
				throw new Error("invalid terminal Claude result");
			}
			terminal = true;
			agentSessionId = message.session_id;
			continue;
		}
		if (terminal) {
			throw new Error("invalid Claude event");
		}
		if (message.type === "stream_event") {
			const event = message.event;
			switch (event.type) {
				case "message_start":
					if (messageOpen || event.message.id.length === 0) {
						throw new Error("invalid Claude message start");
					}
					messageOpen = true;
					break;
				case "content_block_start":
					if (!messageOpen) throw new Error("invalid Claude content start");
					if (event.content_block.type === "text") {
						if (textId) throw new Error("overlapping Claude text blocks");
						textIndex = event.index;
						textId = `${messageId}-text-${textPartIndex++}`;
						writer.write({ type: "text-start", id: textId });
					}
					break;
				case "content_block_delta":
					if (event.delta.type === "text_delta") {
						if (event.index !== textIndex || !textId) {
							throw new Error("invalid Claude text delta");
						}
						writer.write({
							type: "text-delta",
							id: textId,
							delta: event.delta.text,
						});
						if (event.delta.text.length > 0) wrotePart = true;
					}
					break;
				case "content_block_stop":
					if (event.index === textIndex && textId) {
						writer.write({ type: "text-end", id: textId });
						textIndex = undefined;
						textId = undefined;
					}
					break;
				case "message_stop":
					if (!messageOpen || textId) {
						throw new Error("invalid Claude message stop");
					}
					messageOpen = false;
					break;
			}
			continue;
		}
		if (message.type === "assistant") {
			if (message.error || message.aborted) {
				throw new Error("Claude Assistant message failed");
			}
			for (const block of message.message.content) {
				if (block.type === "tool_use") {
					const tool = publicToolName(block.name);
					if (tool === null || toolInvocations.has(block.id)) {
						throw new Error("invalid Claude Tool invocation");
					}
					const projected = projectToolUse(tool, block.input);
					if (!projected.ok) throw new Error("unsafe Claude Tool invocation");
					const toolCallId = randomUUID();
					toolInvocations.set(block.id, { tool, toolCallId });
					writer.write({
						type: "tool-input-available",
						toolCallId,
						toolName: tool,
						input: projected.payload.arguments,
						dynamic: true,
					});
					wrotePart = true;
				}
			}
			continue;
		}
		if (
			message.type !== "user" ||
			("isReplay" in message && message.isReplay === true) ||
			!Array.isArray(message.message.content)
		) {
			throw new Error("invalid Claude event");
		}
		for (const block of message.message.content) {
			if (block.type !== "tool_result") {
				throw new Error("invalid Claude Tool result");
			}
			const invocation = toolInvocations.get(block.tool_use_id);
			if (!invocation) throw new Error("unmatched Claude Tool result");
			toolInvocations.delete(block.tool_use_id);
			const projected = projectToolResult(
				invocation.tool,
				block.content,
				block.is_error === true,
			);
			if (!projected.ok) throw new Error("unsafe Claude Tool result");
			if (projected.payload.isError) {
				writer.write({
					type: "tool-output-error",
					toolCallId: invocation.toolCallId,
					errorText: "Tool failed",
					dynamic: true,
				});
			} else {
				writer.write({
					type: "tool-output-available",
					toolCallId: invocation.toolCallId,
					output: projected.payload.result,
					dynamic: true,
				});
			}
		}
	}

	if (
		!terminal ||
		!agentSessionId ||
		!wrotePart ||
		messageOpen ||
		textId ||
		toolInvocations.size > 0
	) {
		throw new Error("Claude stream ended before completion");
	}
	return agentSessionId;
}

async function handleAgentQueryChat(
	c: Context<AppEnv>,
	body: z.infer<typeof AgentQueryChatBody>,
	runtimeInvoker: AgentQueryRuntimeInvoker,
) {
	if (!(AI_CHAT_MODELS as readonly string[]).includes(body.model)) {
		return c.json({ error: "Unsupported model" }, 400);
	}
	const ref = {
		userId: c.var.identity.memberCode,
		conversationId: body.id,
	};
	if (!(await c.var.deps.chatMessageStore.ownedConversationExists(ref))) {
		return c.json({ error: "Conversation not found" }, 404);
	}
	if (!(await c.var.deps.exposureGate.isAgentEnabled(c.var.identity))) {
		return c.json({ error: "Agent is not enabled" }, 403);
	}

	const userMessage = body.messages[0] as UIMessage;
	const admission = await c.var.deps.chatMessageStore.admitUserMessage(
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

	const assistantMessageId = randomUUID();
	let agentSessionId: string | undefined;
	const stream = createUIMessageStream<UIMessage>({
		onError: () => "Response failed",
		async onEnd({ finishReason, isAborted, responseMessage }) {
			if (finishReason !== "stop" || isAborted) return;
			if (!agentSessionId) throw new Error("Agent session was not completed");
			await c.var.deps.chatMessageStore.persistAssistantMessageAndSession(
				ref,
				responseMessage,
				agentSessionId,
			);
		},
		async execute({ writer }) {
			const events = await runtimeInvoker.invoke({
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

export function createAiChatRoutes(runtimeInvoker: AgentQueryRuntimeInvoker) {
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
		(c) => handleAgentQueryChat(c, c.req.valid("json"), runtimeInvoker),
	);
	return routes;
}
