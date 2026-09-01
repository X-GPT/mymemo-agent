import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Test-only scripted SDK streams in the pinned partial-message protocol: a
 * provider call is `message_start` … per-content-block `assistant`
 * completions … `message_stop`. The fixtures build only the fields the
 * mapper reads; the cast stands in for the SDK's wire envelope.
 */

export function streamEvent(
	event: object,
	parentToolUseId: string | null = null,
): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: parentToolUseId,
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

export function assistantMessage(
	blocks: object[],
	parentToolUseId: string | null = null,
): SDKMessage {
	return {
		type: "assistant",
		message: { id: "msg_provider", content: blocks },
		parent_tool_use_id: parentToolUseId,
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

export function toolResultMessage(
	toolUseId: string,
	content: unknown,
	isError = false,
): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content,
					is_error: isError,
				},
			],
		},
		parent_tool_use_id: null,
	} as unknown as SDKMessage;
}

export function resultSuccess(): SDKMessage {
	return { type: "result", subtype: "success" } as unknown as SDKMessage;
}

export function resultError(errors: string[] = []): SDKMessage {
	return {
		type: "result",
		subtype: "error_during_execution",
		errors,
	} as unknown as SDKMessage;
}

/** One full text Step: start → text block streamed and completed → stop. */
export function textStep(text: string): SDKMessage[] {
	return [
		streamEvent({ type: "message_start", message: { id: "msg_provider" } }),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		}),
		assistantMessage([{ type: "text", text }]),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_stop" }),
	];
}

/** One full tool Step: a `tool_use` block whose input arrives complete. */
export function toolStep(input: {
	toolUseId: string;
	toolName: string;
	toolInput: unknown;
}): SDKMessage[] {
	return [
		streamEvent({ type: "message_start", message: { id: "msg_provider" } }),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "tool_use",
				id: input.toolUseId,
				name: input.toolName,
			},
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: "{" },
		}),
		assistantMessage([
			{
				type: "tool_use",
				id: input.toolUseId,
				name: input.toolName,
				input: input.toolInput,
			},
		]),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_stop" }),
	];
}
