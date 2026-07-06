/**
 * The client-facing SSE frame shapes and the projector's terminal-type set.
 *
 * The `run_events.type` write-side vocabulary ({@link RunEventType}) lives in the
 * shared `@mymemo/agent-db` package so every appender — chat-api's run queue and
 * the agent-worker — writes the same strings the projector reads; it is
 * re-exported here so chat-api keeps importing it from `@/features/run-events`.
 *
 * This module is the single authority for what a client can SEE: the projector
 * ({@link projectRunEvent}) derives the client SSE stream from recorded events,
 * fail-closed — an internal event type without an explicit frame mapping
 * produces no frame, so a new internal event type can never leak to clients by
 * accident.
 *
 * The prototype-era `sandbox_id` / `agent_session_id` frames are deliberately
 * absent: they are internal runtime identifiers, found in `run_events`, not in
 * the client stream (see the design doc's client contract).
 */

import { RunEventType } from "@mymemo/agent-db/run-events";

export { RunEventType };

/**
 * The terminal event types. When the projector reads one of these it emits the
 * matching terminal frame (if any) and closes the stream — detection is by
 * event type, not by whether a frame was produced, so a terminal event with a
 * malformed payload still ends the stream.
 */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
	RunEventType.Done,
	RunEventType.Error,
	RunEventType.Canceled,
]);

/**
 * The client-visible SSE frames. `type` is also the SSE `event:` name. This is
 * the whole split-runtime client vocabulary — `conversation_id`, `run_id`,
 * `text_delta`, and one terminal frame per outcome (`done | canceled | error`).
 */
export type ClientFrame =
	| { type: "conversation_id"; conversationId: string }
	| { type: "run_id"; runId: string }
	| { type: "text_delta"; text: string }
	| { type: "done" }
	| { type: "canceled" }
	| { type: "error"; message: string };
