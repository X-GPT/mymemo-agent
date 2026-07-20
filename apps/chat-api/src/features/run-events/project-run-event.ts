import {
	isAssistantTextPayload,
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
		// The recorded tool payloads ARE the client-safe projection (ADR-0009 —
		// projected once, worker-side, before append); after the shared guard
		// validates the shape, the frame forwards the payload fields verbatim.
		case RunEventType.ToolUse:
			return isToolUsePayload(payload)
				? [
						{
							type: "tool_use",
							tool: payload.tool,
							arguments: payload.arguments,
							truncated: payload.truncated,
						},
					]
				: [];
		case RunEventType.ToolResult:
			return isToolResultPayload(payload)
				? [
						{
							type: "tool_result",
							tool: payload.tool,
							result: payload.result,
							isError: payload.isError,
							truncated: payload.truncated,
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
