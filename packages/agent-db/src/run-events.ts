/**
 * The `run_events.type` vocabulary — the write-side contract for the durable
 * run-event log, shared by every appender so the type strings are defined in
 * exactly one place: chat-api's run queue writes `run_started`; the agent-worker
 * writes assistant text and tool events and, through the run-store terminal
 * helpers, the terminal events. chat-api's projector is the READ side — it maps
 * these types to client SSE frames, and an unmapped type produces no frame
 * (fail-closed).
 *
 * Appenders MUST use these constants, never the raw strings, so a rename cannot
 * silently desync a writer from the projector (a text event written under the
 * wrong type would simply never reach the client).
 */
export const RunEventType = {
	/** First event of a run. Payload `{ conversationId, runId, ... }`. */
	Started: "run_started",
	/** One complete Assistant message. Payload `{ messageId, text }`. Projected
	 * to the durable `text_commit` client frame. */
	AssistantText: "assistant_text",
	/** One Tool invocation. Payload {@link ToolUsePayload} — already the
	 * client-safe projection (ADR-0009); the projector forwards, never derives. */
	ToolUse: "tool_use",
	/** One Tool result. Payload {@link ToolResultPayload}. */
	ToolResult: "tool_result",
	/** Terminal: the run finished successfully. */
	Done: "run_done",
	/** Terminal: the run failed. Payload `{ message }`. */
	Error: "run_error",
	/** Terminal: the run was canceled by the user. */
	Canceled: "run_canceled",
} as const;

export type RunEventType = (typeof RunEventType)[keyof typeof RunEventType];

/** The durable payload for one complete Assistant message. */
export interface AssistantTextPayload {
	[key: string]: unknown;
	messageId: string;
	text: string;
}

export function isAssistantTextPayload(
	value: unknown,
): value is AssistantTextPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"messageId" in value &&
		typeof value.messageId === "string" &&
		value.messageId.length > 0 &&
		"text" in value &&
		typeof value.text === "string" &&
		value.text.length > 0
	);
}

/**
 * The nine short public tool names a client may see (ADR-0009). Tool events
 * carry these — never the executor's prefixed tool names — and the guards fail
 * closed on anything else, so an internal name cannot reach the client stream.
 */
export const PUBLIC_TOOL_NAMES = [
	"Read",
	"Write",
	"Edit",
	"Grep",
	"Glob",
	"Bash",
	"ListDocuments",
	"SearchDocuments",
	"LoadDocuments",
] as const;

export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];

/**
 * The durable payload for one Tool invocation (ADR-0009). `arguments` is the
 * bounded per-tool projection of what the tool was asked to do — recorded
 * already client-safe, never raw SDK input — and `truncated` marks that some
 * field was clipped to fit the event cap.
 */
export interface ToolUsePayload {
	[key: string]: unknown;
	tool: PublicToolName;
	arguments: Record<string, unknown>;
	truncated: boolean;
}

/**
 * The durable payload for one Tool result (ADR-0009). `result` is the bounded
 * per-tool projection of what came back; an `isError` result carries the fixed
 * safe message, never raw error text.
 */
export interface ToolResultPayload {
	[key: string]: unknown;
	tool: PublicToolName;
	result: Record<string, unknown>;
	isError: boolean;
	truncated: boolean;
}

export function isToolUsePayload(value: unknown): value is ToolUsePayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"tool" in value &&
		isPublicToolName(value.tool) &&
		"arguments" in value &&
		isPlainRecord(value.arguments) &&
		"truncated" in value &&
		typeof value.truncated === "boolean"
	);
}

export function isToolResultPayload(
	value: unknown,
): value is ToolResultPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"tool" in value &&
		isPublicToolName(value.tool) &&
		"result" in value &&
		isPlainRecord(value.result) &&
		"isError" in value &&
		typeof value.isError === "boolean" &&
		"truncated" in value &&
		typeof value.truncated === "boolean"
	);
}

function isPublicToolName(value: unknown): value is PublicToolName {
	return (
		typeof value === "string" &&
		(PUBLIC_TOOL_NAMES as readonly string[]).includes(value)
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
