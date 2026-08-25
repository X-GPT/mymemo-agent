import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sValidator as zValidator } from "@hono/standard-validator";
import type { PublicToolName } from "@mymemo/agent-db/run-events";
import {
	projectToolResult,
	projectToolUse,
	publicToolName,
} from "@mymemo/agent-db/tool-event-projection";
import {
	type AgentQueryRequest,
	watchResponseAuthority,
} from "@mymemo/agent-query";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	UI_MESSAGE_STREAM_HEADERS,
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
		| "clearActiveStreamId"
		| "clearResponseAuthority"
		| "getActiveStream"
		| "listMessages"
		| "persistAssistantMessageAndSession"
		| "renewResponseAuthority"
		| "setActiveStreamId"
	>;
	runtimeInvoker: {
		invoke(
			request: AgentQueryRequest,
			signal?: AbortSignal,
		): Promise<AsyncIterable<SDKMessage> | Iterable<SDKMessage>>;
	};
	exposureGate: ExposureGate;
	resumableStreams?: {
		create(streamId: string, stream: ReadableStream<string>): Promise<void>;
		resume(
			streamId: string,
		): Promise<ReadableStream<string> | null | undefined>;
	};
	createMessageId?: () => string;
	createStreamId?: () => string;
	responseRenewIntervalMs?: number;
};

async function writeClaudeMessageStream(
	writer: UIMessageStreamWriter<ChatMessage>,
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
		case "conflict":
			return c.json({ error: "A response is already active" }, 409);
		case "duplicate":
			return c.json({ error: "Message id was already used" }, 409);
	}

	const activeStreamId = (deps.createStreamId ?? randomUUID)();
	const assistantMessageId = (deps.createMessageId ?? randomUUID)();
	let agentSessionId: string | undefined;
	let renewal: ReturnType<typeof watchResponseAuthority> | undefined;
	const stream = createUIMessageStream<ChatMessage>({
		onError: () => "Response failed",
		async onEnd({ finishReason, isAborted, responseMessage }) {
			try {
				if (finishReason !== "stop" || isAborted) {
					await deps.messageStore.clearResponseAuthority(
						ref,
						admission.conversationEpoch,
					);
					return;
				}
				if (!agentSessionId) throw new Error("Agent session was not completed");
				try {
					await deps.messageStore.persistAssistantMessageAndSession(
						ref,
						admission.conversationEpoch,
						responseMessage,
						agentSessionId,
					);
				} catch (error) {
					await deps.messageStore.clearResponseAuthority(
						ref,
						admission.conversationEpoch,
					);
					throw error;
				}
			} finally {
				renewal?.stop();
			}
		},
		async execute({ writer }) {
			renewal = watchResponseAuthority({
				initialDeadline: admission.responseDeadline,
				intervalMs: deps.responseRenewIntervalMs ?? 15_000,
				verify: () =>
					deps.messageStore.renewResponseAuthority(
						ref,
						admission.conversationEpoch,
					),
			});
			const events = await deps.runtimeInvoker.invoke(
				{
					version: 1,
					conversationId: body.id,
					conversationEpoch: admission.conversationEpoch,
					prompt: body.messages[0].parts[0].text,
					model: body.model,
					...(admission.agentSessionId
						? { agentSessionId: admission.agentSessionId }
						: {}),
				},
				renewal.signal,
			);
			agentSessionId = await writeClaudeMessageStream(
				writer,
				events,
				assistantMessageId,
			);
			writer.write({ type: "finish", finishReason: "stop" });
		},
	});
	const resumableStreams = deps.resumableStreams;
	return createUIMessageStreamResponse({
		stream,
		consumeSseStream: resumableStreams
			? async ({ stream: sseStream }) => {
					try {
						await resumableStreams.create(activeStreamId, sseStream);
						await deps.messageStore.setActiveStreamId(
							ref,
							admission.conversationEpoch,
							activeStreamId,
						);
					} catch {
						await Promise.allSettled([
							deps.messageStore.clearActiveStreamId(
								ref,
								admission.conversationEpoch,
								activeStreamId,
							),
							sseStream.cancel(),
						]);
					}
				}
			: undefined,
	});
}

export function createAiChatRoutes(injectedDeps?: AgentQueryChatDeps) {
	const routes = new Hono<AppEnv>();
	routes.get("/:conversationId", requireInternalIdentity, async (c) => {
		const messageStore =
			injectedDeps?.messageStore ?? c.var.deps.chatMessageStore;
		const conversationId = ConversationIdParam.safeParse(
			c.req.param("conversationId"),
		);
		if (!conversationId.success) {
			return c.json({ error: "Invalid Conversation id" }, 400);
		}
		const history = await messageStore.listMessages({
			userId: c.var.identity.memberCode,
			conversationId: conversationId.data,
		});
		if (history.outcome === "not_found") {
			return c.json({ error: "Conversation not found" }, 404);
		}
		return c.json(history.messages);
	});
	routes.get("/:conversationId/stream", requireInternalIdentity, async (c) => {
		const messageStore =
			injectedDeps?.messageStore ?? c.var.deps.chatMessageStore;
		const resumableStreams = injectedDeps
			? injectedDeps.resumableStreams
			: c.var.deps.resumableStreams;
		const conversationId = ConversationIdParam.safeParse(
			c.req.param("conversationId"),
		);
		if (!conversationId.success) {
			return c.json({ error: "Invalid Conversation id" }, 400);
		}
		const ref = {
			userId: c.var.identity.memberCode,
			conversationId: conversationId.data,
		};
		const active = await messageStore.getActiveStream(ref);
		if (active.outcome === "not_found") {
			return c.json({ error: "Conversation not found" }, 404);
		}
		if (!active.activeStreamId || !resumableStreams) {
			return c.body(null, 204);
		}
		let stream: ReadableStream<string> | null | undefined;
		try {
			stream = await resumableStreams.resume(active.activeStreamId);
		} catch {
			return c.json({ error: "Response resumption unavailable" }, 503);
		}
		if (!stream) {
			await messageStore
				.clearActiveStreamId(
					ref,
					active.conversationEpoch,
					active.activeStreamId,
				)
				.catch(() => false);
			return c.body(null, 204);
		}
		return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
	});
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
		(c) => {
			if (injectedDeps) {
				return handleAgentQueryChat(c, c.req.valid("json"), injectedDeps);
			}
			const runtimeInvoker = c.var.deps.agentQueryRuntimeInvoker;
			if (!runtimeInvoker) {
				return c.json({ error: "Direct response unavailable" }, 503);
			}
			return handleAgentQueryChat(c, c.req.valid("json"), {
				messageStore: c.var.deps.chatMessageStore,
				runtimeInvoker,
				exposureGate: c.var.deps.exposureGate,
				resumableStreams: c.var.deps.resumableStreams,
			});
		},
	);
	return routes;
}

export default createAiChatRoutes();
