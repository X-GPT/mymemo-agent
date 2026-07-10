import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "s",
	} as unknown as SDKMessage;
}

export function assistantBlock(
	providerMessageId: string,
	content: Record<string, unknown>,
	error?: string,
): SDKMessage {
	return {
		type: "assistant",
		message: { id: providerMessageId, content: [content] },
		...(error ? { error } : {}),
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "s",
	} as unknown as SDKMessage;
}

export function textEnvelope(input: {
	completeText: string;
	providerMessageId?: string;
	partialText?: string;
}): SDKMessage[] {
	const providerMessageId = input.providerMessageId ?? "provider-message-1";
	return [
		streamEvent({
			type: "message_start",
			message: { id: providerMessageId, content: [] },
		}),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "text_delta",
				text: input.partialText ?? input.completeText,
			},
		}),
		assistantBlock(providerMessageId, {
			type: "text",
			text: input.completeText,
		}),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_stop" }),
	];
}
