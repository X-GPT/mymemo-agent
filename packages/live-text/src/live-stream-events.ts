import {
	type AGUIEvent,
	EventSchemas,
	EventType,
	type TextMessageContentEvent,
} from "@ag-ui/core";
import { z } from "zod";
import type { LiveStreamReason } from "./live-stream-telemetry";
import { LIVE_STREAM_RUN_ID_MAX_LENGTH } from "./live-stream-validation";

export const LIVE_STREAM_MAX_EVENT_BYTES = 32 * 1_024;
export const LIVE_STREAM_MAX_BYTES = 8 * 1_024 * 1_024;
export const LIVE_STREAM_MAX_EVENTS = 10_000;
export const LIVE_STREAM_TEXT_EVENT_TARGET_BYTES = 16 * 1_024;

const EVENT_ENCODER = new TextEncoder();
const EVENT_DECODER = new TextDecoder("utf-8", { fatal: true });

/** The custom interruption terminal (ADR-0013): AG-UI's core package carries
 * no user-interruption terminal (its `RUN_FINISHED` interrupt outcome means a
 * pending HITL interrupt), so define the strict wire shape at the Live Stream
 * boundary. Never carries an Agent-session id. */
export const RUN_INTERRUPTED_EVENT_TYPE = "RUN_INTERRUPTED" as const;
const RunInterruptedEventSchema = z
	.object({
		type: z.literal(RUN_INTERRUPTED_EVENT_TYPE),
		threadId: z.string().min(1).max(LIVE_STREAM_RUN_ID_MAX_LENGTH),
		runId: z.string().min(1).max(LIVE_STREAM_RUN_ID_MAX_LENGTH),
	})
	.strict();

export type RunInterruptedEvent = z.infer<typeof RunInterruptedEventSchema>;
export type LiveStreamEvent = AGUIEvent | RunInterruptedEvent;

export type LiveStreamRelayErrorCode =
	| "invalid_event"
	| "event_too_large"
	| "producer_closed"
	| "producer_failed"
	| "relay_closed"
	| "relay_failed"
	| "stream_bytes_exceeded"
	| "stream_events_exceeded"
	| "terminal_already_published"
	| "terminal_not_allowed"
	| "terminal_required";

export class LiveStreamRelayError extends Error {
	override readonly name = "LiveStreamRelayError";

	constructor(readonly code: LiveStreamRelayErrorCode) {
		super(errorMessage(code));
	}
}

/** Collapse adapter and infrastructure failures to the bounded reason
 * vocabulary shared by producer and reconnect telemetry. */
export function classifyLiveStreamFailure(error: unknown): LiveStreamReason {
	return error instanceof LiveStreamRelayError
		? error.code
		: "redis_unavailable";
}

/**
 * Validate and serialize one standard AG-UI event. Large text-content deltas
 * become several complete events; no other event is split or truncated.
 */
export function encodeAgUiLiveStreamEvent(
	event: LiveStreamEvent,
): Uint8Array[] {
	const parsed = parseLiveStreamEvent(event);
	const encoded = encodeEvent(parsed);
	if (parsed.type !== EventType.TEXT_MESSAGE_CONTENT) {
		if (encoded.byteLength > LIVE_STREAM_MAX_EVENT_BYTES) {
			throw new LiveStreamRelayError("event_too_large");
		}
		return [encoded];
	}
	if (encoded.byteLength <= LIVE_STREAM_TEXT_EVENT_TARGET_BYTES) {
		return [encoded];
	}
	return splitTextContentEvent(parsed);
}

export function decodeAgUiLiveStreamEvent(chunk: Uint8Array): LiveStreamEvent {
	try {
		return parseLiveStreamEvent(JSON.parse(EVENT_DECODER.decode(chunk)));
	} catch {
		throw new LiveStreamRelayError("invalid_event");
	}
}

function parseLiveStreamEvent(event: unknown): LiveStreamEvent {
	if (
		typeof event === "object" &&
		event !== null &&
		"type" in event &&
		event.type === RUN_INTERRUPTED_EVENT_TYPE
	) {
		return RunInterruptedEventSchema.parse(event);
	}
	return EventSchemas.parse(event);
}

function encodeEvent(event: LiveStreamEvent): Uint8Array {
	return EVENT_ENCODER.encode(JSON.stringify(event));
}

function splitTextContentEvent(event: TextMessageContentEvent): Uint8Array[] {
	const emptyEventBytes = encodeEvent({ ...event, delta: "" }).byteLength;
	const deltaBudget = LIVE_STREAM_TEXT_EVENT_TARGET_BYTES - emptyEventBytes;
	if (deltaBudget < 1) {
		throw new LiveStreamRelayError("event_too_large");
	}

	const deltas: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const codePoint of event.delta) {
		const codePointBytes = jsonStringContentBytes(codePoint);
		if (codePointBytes > deltaBudget) {
			throw new LiveStreamRelayError("event_too_large");
		}
		if (current && currentBytes + codePointBytes > deltaBudget) {
			deltas.push(current);
			current = "";
			currentBytes = 0;
		}
		current += codePoint;
		currentBytes += codePointBytes;
	}
	if (current) deltas.push(current);
	if (deltas.length === 0) {
		throw new LiveStreamRelayError("event_too_large");
	}

	return deltas.map((delta) => {
		const chunk = encodeEvent({ ...event, delta });
		if (chunk.byteLength > LIVE_STREAM_TEXT_EVENT_TARGET_BYTES) {
			throw new LiveStreamRelayError("event_too_large");
		}
		return chunk;
	});
}

function jsonStringContentBytes(value: string): number {
	return EVENT_ENCODER.encode(JSON.stringify(value)).byteLength - 2;
}

function errorMessage(code: LiveStreamRelayErrorCode): string {
	switch (code) {
		case "invalid_event":
			return "Live Stream payload is not a standard AG-UI event";
		case "event_too_large":
			return "Live Stream event exceeds the size limit";
		case "producer_closed":
			return "Live Stream producer is closed";
		case "producer_failed":
			return "Live Stream producer has failed";
		case "relay_closed":
			return "Live Stream relay is closed";
		case "relay_failed":
			return "Live Stream relay failed";
		case "stream_bytes_exceeded":
			return "Live Stream byte limit exceeded";
		case "stream_events_exceeded":
			return "Live Stream event limit exceeded";
		case "terminal_already_published":
			return "Live Stream terminal event was already published";
		case "terminal_not_allowed":
			return "append does not accept terminal AG-UI events";
		case "terminal_required":
			return "publishTerminal requires a terminal AG-UI event";
	}
}
