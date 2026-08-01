/**
 * The `run_events.type` vocabulary — the write-side contract for the durable
 * run-event log, shared by every appender so the type strings are defined in
 * exactly one place: chat-api's run queue writes `run_started`; the agent-worker
 * writes assistant text and tool events and, through the run-store terminal
 * helpers, the terminal events. Permanent-history readers consume this same
 * vocabulary; live AG-UI delivery uses the separate producer-buffered relay.
 *
 * Appenders MUST use these constants, never the raw strings, so a rename cannot
 * silently desync a writer from the projector (a text event written under the
 * wrong type would simply never reach the client).
 */
export const RunEventType = {
	/** First event of a run. Payload `{ conversationId, runId, ... }`. */
	Started: "run_started",
	/** One complete Assistant response for AG-UI history. Empty text is valid
	 * when the response owns Tool invocations. */
	AssistantMessageCompleted: "assistant_message_completed",
	/** Stable, correlated AG-UI Tool lifecycle (ADR-0012). */
	ToolCallStarted: "tool_call_started",
	ToolCallArgs: "tool_call_args",
	ToolCallCompleted: "tool_call_completed",
	ToolCallResult: "tool_call_result",
	/** Terminal: the run finished successfully. */
	Done: "run_done",
	/** Terminal: the run failed. Payload `{ message }`. */
	Error: "run_error",
	/** Terminal: the run was interrupted by the user. */
	Interrupted: "run_interrupted",
} as const;

export type RunEventType = (typeof RunEventType)[keyof typeof RunEventType];

export const CANONICAL_MODEL_RUN_EVENT_TYPES = [
	RunEventType.AssistantMessageCompleted,
	RunEventType.ToolCallStarted,
	RunEventType.ToolCallArgs,
	RunEventType.ToolCallCompleted,
	RunEventType.ToolCallResult,
] as const;

export interface RunStartedPayload {
	[key: string]: unknown;
	runId: string;
	conversationId: string;
	messageId: string;
	message: string;
	scope: "general" | "collection" | "document";
	collectionId: string | null;
	summaryId: string | null;
}

export type RunScope = RunStartedPayload["scope"];

export interface AssistantMessageCompletedPayload {
	[key: string]: unknown;
	messageId: string;
	text: string;
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

export interface ToolCallStartedPayload {
	[key: string]: unknown;
	toolCallId: string;
	toolCallName: PublicToolName;
	parentMessageId: string;
}

export interface ToolCallArgsPayload {
	[key: string]: unknown;
	toolCallId: string;
	delta: string;
}

export interface ToolCallCompletedPayload {
	[key: string]: unknown;
	toolCallId: string;
}

export interface ToolCallResultPayload {
	[key: string]: unknown;
	messageId: string;
	toolCallId: string;
	content: string;
	isError: boolean;
}

export type RunOutcome = "done" | "error" | "interrupted";

export interface RunOutcomePayload {
	[key: string]: unknown;
	outcome: RunOutcome;
	message?: string;
}

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

export type DurableRunEvent =
	| { type: typeof RunEventType.Started; payload: RunStartedPayload }
	| {
			type: typeof RunEventType.AssistantMessageCompleted;
			payload: AssistantMessageCompletedPayload;
	  }
	| {
			type: typeof RunEventType.ToolCallStarted;
			payload: ToolCallStartedPayload;
	  }
	| { type: typeof RunEventType.ToolCallArgs; payload: ToolCallArgsPayload }
	| {
			type: typeof RunEventType.ToolCallCompleted;
			payload: ToolCallCompletedPayload;
	  }
	| { type: typeof RunEventType.ToolCallResult; payload: ToolCallResultPayload }
	| {
			type:
				| typeof RunEventType.Done
				| typeof RunEventType.Error
				| typeof RunEventType.Interrupted;
			payload: RunOutcomePayload;
	  };

/** A known durable event has a corrupt payload/type combination. The error
 * names only the type so client content never enters logs through its message. */
export class InvalidRunEventError extends Error {
	override name = "InvalidRunEventError" as const;
}

/**
 * Validate identity and lifecycle relationships across canonical durable
 * model events. Writers call this while holding the Run row lock, and history
 * readers can apply the same rules to reject corrupt known sequences.
 */
export function validateDurableRunEventSequence(
	events: readonly { type: string; payload: unknown }[],
	options: { allowIncomplete?: boolean } = {},
): void {
	const assistantMessageIds = new Set<string>();
	const completedAssistantMessageIds = new Set<string>();
	const submittedMessageIds = new Set<string>();
	const toolResultMessageIds = new Set<string>();
	const toolStates = new Map<
		string,
		"started" | "args" | "completed" | "result"
	>();
	let terminalSeen = false;
	let terminalOutcome: RunOutcome | null = null;
	let livenessSweepOutcome = false;

	for (const event of events) {
		const parsed = parseDurableRunEvent(event.type, event.payload);
		if (!parsed) continue;
		if (terminalSeen) invalidSequence("public event follows terminal Outcome");

		switch (parsed.type) {
			case RunEventType.Started:
				if (
					submittedMessageIds.size > 0 ||
					assistantMessageIds.has(parsed.payload.messageId) ||
					toolResultMessageIds.has(parsed.payload.messageId)
				) {
					invalidSequence("duplicate messageId");
				}
				submittedMessageIds.add(parsed.payload.messageId);
				break;
			case RunEventType.AssistantMessageCompleted:
				if (
					completedAssistantMessageIds.has(parsed.payload.messageId) ||
					submittedMessageIds.has(parsed.payload.messageId) ||
					toolResultMessageIds.has(parsed.payload.messageId)
				) {
					invalidSequence("duplicate messageId");
				}
				assistantMessageIds.add(parsed.payload.messageId);
				completedAssistantMessageIds.add(parsed.payload.messageId);
				break;
			case RunEventType.ToolCallStarted:
				if (toolStates.has(parsed.payload.toolCallId)) {
					invalidSequence("duplicate toolCallId");
				}
				if (
					submittedMessageIds.has(parsed.payload.parentMessageId) ||
					toolResultMessageIds.has(parsed.payload.parentMessageId)
				) {
					invalidSequence("Tool invocation has an invalid parent message");
				}
				assistantMessageIds.add(parsed.payload.parentMessageId);
				toolStates.set(parsed.payload.toolCallId, "started");
				break;
			case RunEventType.ToolCallArgs:
				if (toolStates.get(parsed.payload.toolCallId) !== "started") {
					invalidSequence("Tool arguments do not follow Tool start");
				}
				toolStates.set(parsed.payload.toolCallId, "args");
				break;
			case RunEventType.ToolCallCompleted:
				if (toolStates.get(parsed.payload.toolCallId) !== "args") {
					invalidSequence(
						"Tool completion does not follow one arguments event",
					);
				}
				toolStates.set(parsed.payload.toolCallId, "completed");
				break;
			case RunEventType.ToolCallResult:
				if (toolStates.get(parsed.payload.toolCallId) !== "completed") {
					invalidSequence("Tool result has no completed invocation");
				}
				if (
					submittedMessageIds.has(parsed.payload.messageId) ||
					assistantMessageIds.has(parsed.payload.messageId) ||
					toolResultMessageIds.has(parsed.payload.messageId)
				) {
					invalidSequence("duplicate messageId");
				}
				toolResultMessageIds.add(parsed.payload.messageId);
				toolStates.set(parsed.payload.toolCallId, "result");
				break;
			case RunEventType.Done:
			case RunEventType.Error:
			case RunEventType.Interrupted:
				terminalSeen = true;
				terminalOutcome = parsed.payload.outcome;
				livenessSweepOutcome =
					parsed.payload.outcome !== "done" &&
					parsed.payload.reason === "stale_worker";
				break;
		}
	}

	if (options.allowIncomplete) return;
	if (!livenessSweepOutcome) {
		for (const state of toolStates.values()) {
			if (state === "started" || state === "args") {
				invalidSequence("Tool invocation lifecycle is incomplete");
			}
		}
	}
	if (terminalOutcome === "done") {
		for (const messageId of assistantMessageIds) {
			if (!completedAssistantMessageIds.has(messageId)) {
				invalidSequence("successful Tool-owning Assistant is incomplete");
			}
		}
	}
}

function invalidSequence(reason: string): never {
	throw new InvalidRunEventError(`invalid durable event sequence: ${reason}`);
}

/**
 * Parse the public durable vocabulary for permanent-history consumers.
 * Unknown internal events return `null` and stay fail-closed; a known type with
 * a malformed payload throws so history cannot silently become incomplete.
 */
export function parseDurableRunEvent(
	type: string,
	payload: unknown,
): DurableRunEvent | null {
	switch (type) {
		case RunEventType.Started:
			if (isRunStartedPayload(payload)) return { type, payload };
			break;
		case RunEventType.AssistantMessageCompleted:
			if (isAssistantMessageCompletedPayload(payload)) return { type, payload };
			break;
		case RunEventType.ToolCallStarted:
			if (isToolCallStartedPayload(payload)) return { type, payload };
			break;
		case RunEventType.ToolCallArgs:
			if (isToolCallArgsPayload(payload)) return { type, payload };
			break;
		case RunEventType.ToolCallCompleted:
			if (isToolCallCompletedPayload(payload)) return { type, payload };
			break;
		case RunEventType.ToolCallResult:
			if (isToolCallResultPayload(payload)) return { type, payload };
			break;
		case RunEventType.Done:
			if (isRunOutcomePayload(payload, "done")) return { type, payload };
			break;
		case RunEventType.Error:
			if (isRunOutcomePayload(payload, "error")) return { type, payload };
			break;
		case RunEventType.Interrupted:
			if (isRunOutcomePayload(payload, "interrupted")) return { type, payload };
			break;
		default:
			return null;
	}
	throw new InvalidRunEventError(`invalid payload for durable event ${type}`);
}

export function isRunStartedPayload(
	value: unknown,
): value is RunStartedPayload {
	if (!isPlainRecord(value)) return false;
	return (
		isNonEmptyString(value.runId) &&
		isNonEmptyString(value.conversationId) &&
		isNonEmptyString(value.messageId) &&
		isNonEmptyString(value.message) &&
		(value.scope === "general" ||
			value.scope === "collection" ||
			value.scope === "document") &&
		isNullableString(value.collectionId) &&
		isNullableString(value.summaryId)
	);
}

export function isAssistantMessageCompletedPayload(
	value: unknown,
): value is AssistantMessageCompletedPayload {
	return (
		isPlainRecord(value) &&
		isNonEmptyString(value.messageId) &&
		typeof value.text === "string"
	);
}

export function isToolCallStartedPayload(
	value: unknown,
): value is ToolCallStartedPayload {
	return (
		isPlainRecord(value) &&
		isNonEmptyString(value.toolCallId) &&
		isPublicToolName(value.toolCallName) &&
		isNonEmptyString(value.parentMessageId)
	);
}

export function isToolCallArgsPayload(
	value: unknown,
): value is ToolCallArgsPayload {
	return (
		isPlainRecord(value) &&
		isNonEmptyString(value.toolCallId) &&
		typeof value.delta === "string"
	);
}

export function isToolCallCompletedPayload(
	value: unknown,
): value is ToolCallCompletedPayload {
	return isPlainRecord(value) && isNonEmptyString(value.toolCallId);
}

export function isToolCallResultPayload(
	value: unknown,
): value is ToolCallResultPayload {
	return (
		isPlainRecord(value) &&
		isNonEmptyString(value.messageId) &&
		isNonEmptyString(value.toolCallId) &&
		typeof value.content === "string" &&
		typeof value.isError === "boolean"
	);
}

export function isRunOutcomePayload(
	value: unknown,
	expected: RunOutcome,
): value is RunOutcomePayload {
	if (!isPlainRecord(value) || value.outcome !== expected) return false;
	return expected === "error"
		? isNonEmptyString(value.message)
		: value.message === undefined;
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

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}
