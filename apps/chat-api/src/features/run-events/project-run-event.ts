import {
	isAssistantTextPayload,
	isToolCallArgsPayload,
	isToolCallCompletedPayload,
	isToolCallResultPayload,
	isToolCallStartedPayload,
	isToolResultPayload,
	isToolUsePayload,
} from "@mymemo/agent-db/run-events";
import { type ClientFrame, RunEventType } from "./run-event-types";

/**
 * Derive the client SSE frame(s) for one recorded run event. This is the single
 * authority for client exposure: an event type with no case here produces no
 * frame (fail-closed — an unmapped internal type cannot reach the client).
 *
 * A single event may fan out to more than one frame (`run_started` announces
 * both the conversation id and the run id). Payloads come from a jsonb column
 * and are typed `unknown`; every field is read defensively and a field of the
 * wrong shape is dropped rather than streamed as a malformed frame.
 *
 * Terminal events (`run_done` / `run_error` / `run_canceled`) always map to
 * their terminal frame — even `run_error` with a missing message — so the
 * client is never left without an outcome. The projector loop closes the stream
 * on the terminal *type*, independent of this mapping.
 */
export function projectRunEvent(type: string, payload: unknown): ClientFrame[] {
	const fields = isRecord(payload) ? payload : {};
	switch (type) {
		case RunEventType.Started: {
			const out: ClientFrame[] = [];
			if (typeof fields.conversationId === "string") {
				out.push({
					type: "conversation_id",
					conversationId: fields.conversationId,
				});
			}
			if (typeof fields.runId === "string") {
				out.push({ type: "run_id", runId: fields.runId });
			}
			return out;
		}
		case RunEventType.AssistantText:
		case RunEventType.AssistantMessageCompleted:
			return isAssistantTextPayload(payload)
				? [
						{
							type: "text_commit",
							messageId: payload.messageId,
							text: payload.text,
						},
					]
				: [];
		case RunEventType.ToolCallStarted:
			return isToolCallStartedPayload(payload)
				? [
						{
							type: "TOOL_CALL_START",
							toolCallId: payload.toolCallId,
							toolCallName: payload.toolCallName,
							parentMessageId: payload.parentMessageId,
						},
					]
				: [];
		case RunEventType.ToolCallArgs:
			return isToolCallArgsPayload(payload)
				? [
						{
							type: "TOOL_CALL_ARGS",
							toolCallId: payload.toolCallId,
							delta: payload.delta,
						},
					]
				: [];
		case RunEventType.ToolCallCompleted:
			return isToolCallCompletedPayload(payload)
				? [
						{
							type: "TOOL_CALL_END",
							toolCallId: payload.toolCallId,
						},
					]
				: [];
		case RunEventType.ToolCallResult:
			return isToolCallResultPayload(payload)
				? [
						{
							type: "TOOL_CALL_RESULT",
							messageId: payload.messageId,
							toolCallId: payload.toolCallId,
							content: payload.content,
							role: "tool",
						},
						...(payload.isError
							? [
									{
										type: "CUSTOM" as const,
										name: "mymemo.tool_result_error",
										value: {
											messageId: payload.messageId,
											toolCallId: payload.toolCallId,
										},
									},
								]
							: []),
					]
				: [];
		// Legacy Tool rows predate stable public identities. Preserve only their
		// bounded client-safe projection as namespaced CUSTOM data; never invent
		// message or Tool-call correlation for them (ADR-0012).
		case RunEventType.ToolUse:
			return isToolUsePayload(payload)
				? [
						{
							type: "CUSTOM",
							name: "mymemo.legacy_tool_invocation",
							value: payload,
						},
					]
				: [];
		case RunEventType.ToolResult:
			return isToolResultPayload(payload)
				? [
						{
							type: "CUSTOM",
							name: "mymemo.legacy_tool_result",
							value: payload,
						},
					]
				: [];
		case RunEventType.Done:
			return [{ type: "done" }];
		case RunEventType.Canceled:
			return [{ type: "canceled" }];
		case RunEventType.Error:
			return [
				{
					type: "error",
					message:
						typeof fields.message === "string" ? fields.message : "Run failed",
				},
			];
		default:
			return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
