import {
	type AGUIEvent,
	EventSchemas,
	EventType,
	type TextMessageContentEvent,
} from "@ag-ui/core";
import { z } from "zod";
import type { LiveStreamReason } from "./live-stream-telemetry";

export const LIVE_STREAM_MAX_EVENT_BYTES = 32 * 1_024;
export const LIVE_STREAM_MAX_BYTES = 8 * 1_024 * 1_024;
export const LIVE_STREAM_MAX_EVENTS = 10_000;
export const LIVE_STREAM_TEXT_EVENT_TARGET_BYTES = 16 * 1_024;

const MAX_RUN_ID_LENGTH = 128;
const EVENT_ENCODER = new TextEncoder();
const EVENT_DECODER = new TextDecoder("utf-8", { fatal: true });

/** AG-UI's cancellation terminal is not present in the currently pinned core
 * package, so keep its standard wire shape at the Live Stream boundary. */
export const RUN_CANCELLED_EVENT_TYPE = "RUN_CANCELLED" as const;
const RunCancelledEventSchema = z
	.object({
		type: z.literal(RUN_CANCELLED_EVENT_TYPE),
		threadId: z.string().min(1).max(MAX_RUN_ID_LENGTH),
		runId: z.string().min(1).max(MAX_RUN_ID_LENGTH),
	})
	.strict();

export type RunCancelledEvent = z.infer<typeof RunCancelledEventSchema>;
export type LiveStreamEvent = AGUIEvent | RunCancelledEvent;

export type LiveStreamStoreErrorCode =
	| "missing"
	| "finalized"
	| "not_producer"
	| "invalid_cursor"
	| "invalid_event"
	| "append_retry_conflict"
	| "finalize_conflict"
	| "event_too_large"
	| "stream_bytes_exceeded"
	| "stream_events_exceeded";

export class LiveStreamStoreError extends Error {
	override readonly name = "LiveStreamStoreError";

	constructor(readonly code: LiveStreamStoreErrorCode) {
		super(errorMessage(code));
	}
}

/** Collapse adapter and infrastructure failures to the bounded reason
 * vocabulary shared by producer and reconnect telemetry. */
export function classifyLiveStreamFailure(error: unknown): LiveStreamReason {
	return error instanceof LiveStreamStoreError
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
			throw new LiveStreamStoreError("event_too_large");
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
		throw new LiveStreamStoreError("invalid_event");
	}
}

function parseLiveStreamEvent(event: unknown): LiveStreamEvent {
	if (
		typeof event === "object" &&
		event !== null &&
		"type" in event &&
		event.type === RUN_CANCELLED_EVENT_TYPE
	) {
		return RunCancelledEventSchema.parse(event);
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
		throw new LiveStreamStoreError("event_too_large");
	}

	const deltas: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const codePoint of event.delta) {
		const codePointBytes = jsonStringContentBytes(codePoint);
		if (codePointBytes > deltaBudget) {
			throw new LiveStreamStoreError("event_too_large");
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
		throw new LiveStreamStoreError("event_too_large");
	}

	return deltas.map((delta) => {
		const chunk = encodeEvent({ ...event, delta });
		if (chunk.byteLength > LIVE_STREAM_TEXT_EVENT_TARGET_BYTES) {
			throw new LiveStreamStoreError("event_too_large");
		}
		return chunk;
	});
}

function jsonStringContentBytes(value: string): number {
	return EVENT_ENCODER.encode(JSON.stringify(value)).byteLength - 2;
}

function errorMessage(code: LiveStreamStoreErrorCode): string {
	switch (code) {
		case "missing":
			return "Live Stream is unavailable";
		case "finalized":
			return "Live Stream is already finalized";
		case "not_producer":
			return "Live Stream producer ownership is required";
		case "invalid_cursor":
			return "Live Stream cursor is invalid";
		case "invalid_event":
			return "Live Stream entry is not a standard AG-UI event";
		case "append_retry_conflict":
			return "Live Stream append retry conflicts with its prior event";
		case "finalize_conflict":
			return "Live Stream finalization conflicts with its terminal state";
		case "event_too_large":
			return "Live Stream event exceeds the size limit";
		case "stream_bytes_exceeded":
			return "Live Stream byte limit exceeded";
		case "stream_events_exceeded":
			return "Live Stream event limit exceeded";
	}
}
