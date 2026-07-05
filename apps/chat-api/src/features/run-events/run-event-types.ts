/**
 * The split-runtime run-event vocabulary and the client-facing SSE frame shapes.
 *
 * This module is the single authority for what a client can see. Internal run
 * events are recorded in the durable `run_events` table by the worker (and, for
 * `run_started`, by chat-api when it queues the run); the projector derives the
 * client SSE stream from them via {@link projectRunEvent}. The mapping is
 * fail-closed: an internal event type without an explicit frame mapping produces
 * no frame, so a new internal event type can never leak to clients by accident.
 *
 * The prototype-era `sandbox_id` / `agent_session_id` frames are deliberately
 * absent: they are internal runtime identifiers, found in `run_events`, not in
 * the client stream (see the design doc's client contract).
 */

/**
 * The `run_events.type` values the projector understands. Appenders (chat-api's
 * run queue, the worker) must import these constants rather than hard-code the
 * strings, so this module stays the one place the vocabulary is defined.
 */
export const RunEventType = {
	/** First event of a run. Payload `{ conversationId, runId }`. */
	Started: "run_started",
	/** A chunk of streamed assistant text. Payload `{ text }`. */
	AssistantText: "assistant_text",
	/** Terminal: the run finished successfully. */
	Done: "run_done",
	/** Terminal: the run failed. Payload `{ message }`. */
	Error: "run_error",
	/** Terminal: the run was canceled by the user. */
	Canceled: "run_canceled",
} as const;

export type RunEventType = (typeof RunEventType)[keyof typeof RunEventType];

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
