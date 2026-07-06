/**
 * The `run_events.type` vocabulary — the write-side contract for the durable
 * run-event log, shared by every appender so the type strings are defined in
 * exactly one place: chat-api's run queue writes `run_started`; the agent-worker
 * writes assistant text and, through the run-store terminal helpers, the
 * terminal events. chat-api's projector is the READ side — it maps these types
 * to client SSE frames, and an unmapped type produces no frame (fail-closed).
 *
 * Appenders MUST use these constants, never the raw strings, so a rename cannot
 * silently desync a writer from the projector (a text event written under the
 * wrong type would simply never reach the client).
 */
export const RunEventType = {
	/** First event of a run. Payload `{ conversationId, runId, ... }`. */
	Started: "run_started",
	/** A chunk of streamed assistant text. Payload `{ text }`. Projected to the
	 * `text_delta` client frame. */
	AssistantText: "assistant_text",
	/** Terminal: the run finished successfully. */
	Done: "run_done",
	/** Terminal: the run failed. Payload `{ message }`. */
	Error: "run_error",
	/** Terminal: the run was canceled by the user. */
	Canceled: "run_canceled",
} as const;

export type RunEventType = (typeof RunEventType)[keyof typeof RunEventType];
