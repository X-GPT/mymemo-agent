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

export interface ToolUseBlockFixture {
	toolUseId: string;
	/** The prefixed tool name as the SDK reports it (e.g. an executor name). */
	name: string;
	input: Record<string, unknown>;
}

/**
 * One complete provider envelope: optional leading visible text, then
 * `tool_use` blocks in content-block order — the captured ADR-0008 tool
 * sequence shape (partial `input_json_delta` fragments stream first, the SDK
 * `assistant` event then carries the completed block).
 */
export function toolEnvelope(input: {
	providerMessageId?: string;
	text?: string;
	toolUses: ToolUseBlockFixture[];
}): SDKMessage[] {
	const providerMessageId = input.providerMessageId ?? "provider-message-1";
	const messages: SDKMessage[] = [
		streamEvent({
			type: "message_start",
			message: { id: providerMessageId, content: [] },
		}),
	];
	let index = 0;
	if (input.text !== undefined) {
		messages.push(
			streamEvent({
				type: "content_block_start",
				index,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index,
				delta: { type: "text_delta", text: input.text },
			}),
			assistantBlock(providerMessageId, { type: "text", text: input.text }),
			streamEvent({ type: "content_block_stop", index }),
		);
		index++;
	}
	for (const toolUse of input.toolUses) {
		const json = JSON.stringify(toolUse.input);
		const split = Math.ceil(json.length / 2);
		messages.push(
			streamEvent({
				type: "content_block_start",
				index,
				content_block: {
					type: "tool_use",
					id: toolUse.toolUseId,
					name: toolUse.name,
					input: {},
				},
			}),
			streamEvent({
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: json.slice(0, split) },
			}),
			streamEvent({
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: json.slice(split) },
			}),
			assistantBlock(providerMessageId, {
				type: "tool_use",
				id: toolUse.toolUseId,
				name: toolUse.name,
				input: toolUse.input,
			}),
			streamEvent({ type: "content_block_stop", index }),
		);
		index++;
	}
	messages.push(streamEvent({ type: "message_stop" }));
	return messages;
}

export interface ToolResultFixture {
	toolUseId: string;
	text: string;
	isError?: boolean;
}

/**
 * One complete SDK user message carrying `tool_result` blocks in block order.
 * `isReplay` marks the SDK's replayed-transcript variant, which must never
 * produce tool events.
 */
export function toolResultUserMessage(
	results: ToolResultFixture[],
	options: { isReplay?: boolean } = {},
): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: results.map((result) => ({
				type: "tool_result",
				tool_use_id: result.toolUseId,
				content: [{ type: "text", text: result.text }],
				...(result.isError ? { is_error: true } : {}),
			})),
		},
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "s",
		...(options.isReplay ? { isReplay: true } : {}),
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
