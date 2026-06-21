/**
 * Maps recorded run events onto the client-facing SSE vocabulary.
 *
 * The run-state module ({@link "@/features/run-state"}) records a run's
 * lifecycle as an ordered event stream. The client-visible stream is *derived*
 * from those recorded events by this pure function, so every SSE frame the
 * client sees corresponds to an event that was recorded in the run's durable
 * log. Events that have no client-facing meaning (daemon start, hydration,
 * cancellation) map to no SSE frame.
 */

import { AGENT_EVENT_TYPE_FIELD, RunEventType } from "@/features/run-state";
import type { RunEvent } from "@/features/workspace-store";
import type { EventMessage } from "./chat.events";

/**
 * Derive the client SSE frame(s) for one recorded run event. Returns an empty
 * array for run events that carry no client-facing meaning. A single run event
 * may fan out to more than one SSE frame (e.g. `run_started` announces both the
 * conversation id and the run id).
 *
 * Field values are read defensively (`RunEvent` values are typed `unknown`); a
 * field of the wrong shape is dropped rather than streamed as a malformed frame.
 */
export function runEventToClientEvents(event: RunEvent): EventMessage[] {
	switch (event.type) {
		case RunEventType.Started: {
			const out: EventMessage[] = [];
			if (typeof event.conversationId === "string") {
				out.push({
					type: "conversation_id",
					conversationId: event.conversationId,
				});
			}
			if (typeof event.runId === "string") {
				out.push({ type: "run_id", runId: event.runId });
			}
			return out;
		}
		case RunEventType.SandboxLeased:
			return typeof event.sandboxId === "string"
				? [{ type: "sandbox_id", sandboxId: event.sandboxId }]
				: [];
		case RunEventType.AgentEvent: {
			const agentType = event[AGENT_EVENT_TYPE_FIELD];
			if (agentType === "text_delta" && typeof event.text === "string") {
				return [{ type: "text_delta", text: event.text }];
			}
			if (agentType === "session_id" && typeof event.sessionId === "string") {
				return [{ type: "agent_session_id", agentSessionId: event.sessionId }];
			}
			return [];
		}
		case RunEventType.Completed:
			return [{ type: "done" }];
		case RunEventType.Failed:
			return [
				{
					type: "error",
					message: typeof event.error === "string" ? event.error : "Run failed",
				},
			];
		default:
			// daemon_started, hydration, run_canceled, and any future internal-only
			// event carry no client-facing frame.
			return [];
	}
}
