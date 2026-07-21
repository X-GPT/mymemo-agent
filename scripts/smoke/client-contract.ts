export interface ClientContractFrame {
	id?: string;
	event: string;
	data: unknown;
}

export interface ClientContractMessage {
	messageId: string;
	text: string;
	provisional: boolean;
}

/** One rendered canonical Tool lifecycle item (ADR-0012). Stable public ids
 * correlate the invocation, result, and owning Assistant message. */
export type ClientContractToolEvent =
	| {
			kind: "tool_call_start";
			toolCallId: string;
			tool: string;
			parentMessageId: string;
	  }
	| { kind: "tool_call_args"; toolCallId: string; delta: string }
	| { kind: "tool_call_end"; toolCallId: string }
	| {
			kind: "tool_call_result";
			messageId: string;
			toolCallId: string;
			content: string;
	  }
	| { kind: "custom"; name: string; value: unknown };

export type ClientContractTerminal = "done" | "canceled" | "error";

export interface ClientContractSnapshot {
	messages: ClientContractMessage[];
	toolEvents: ClientContractToolEvent[];
	terminal: ClientContractTerminal | undefined;
}

interface StoredMessage extends ClientContractMessage {
	nextDeltaIndex: number;
}

export interface ClientContractFixture {
	receive(frame: ClientContractFrame): void;
	snapshot(): ClientContractSnapshot;
}

export function createClientContractFixture(): ClientContractFixture {
	const messages = new Map<string, StoredMessage>();
	const committedMessageIds = new Set<string>();
	const toolEvents: ClientContractToolEvent[] = [];
	let terminal: ClientContractTerminal | undefined;

	return {
		receive(frame) {
			const data = requireRecord(frame.data);
			if (data.type !== frame.event) {
				throw new Error(`invalid ${frame.event} frame`);
			}
			if (
				terminal !== undefined &&
				(frame.event === "text_delta" ||
					frame.event === "text_commit" ||
					frame.event.startsWith("TOOL_CALL_") ||
					frame.event === "CUSTOM")
			) {
				return;
			}

			switch (frame.event) {
				case "conversation_id":
					requireString(data, "conversationId", frame.event);
					return;
				case "run_id":
					requireString(data, "runId", frame.event);
					return;
				case "text_delta": {
					if (frame.id !== undefined) {
						throw new Error("text_delta must be cursorless");
					}
					const messageId = requireString(data, "messageId", frame.event);
					const text = requireString(data, "text", frame.event);
					const deltaIndex = data.deltaIndex;
					if (!Number.isInteger(deltaIndex) || (deltaIndex as number) < 0) {
						throw new Error("invalid text_delta frame");
					}
					if (committedMessageIds.has(messageId)) return;

					const existing = messages.get(messageId);
					const expectedIndex = existing?.nextDeltaIndex ?? 0;
					if (deltaIndex !== expectedIndex) {
						throw new Error(
							`text_delta index ${deltaIndex} did not match expected ${expectedIndex}`,
						);
					}
					messages.set(messageId, {
						messageId,
						text: `${existing?.text ?? ""}${text}`,
						provisional: true,
						nextDeltaIndex: expectedIndex + 1,
					});
					return;
				}
				case "text_commit": {
					requireCursor(frame);
					const messageId = requireString(data, "messageId", frame.event);
					const text = requireString(data, "text", frame.event);
					messages.set(messageId, {
						messageId,
						text,
						provisional: false,
						nextDeltaIndex: 0,
					});
					committedMessageIds.add(messageId);
					return;
				}
				case "TOOL_CALL_START": {
					requireCursor(frame);
					const toolCallId = requireString(data, "toolCallId", frame.event);
					const tool = requireString(data, "toolCallName", frame.event);
					const parentMessageId = requireString(
						data,
						"parentMessageId",
						frame.event,
					);
					toolEvents.push({
						kind: "tool_call_start",
						toolCallId,
						tool,
						parentMessageId,
					});
					return;
				}
				case "TOOL_CALL_ARGS": {
					requireCursor(frame);
					toolEvents.push({
						kind: "tool_call_args",
						toolCallId: requireString(data, "toolCallId", frame.event),
						delta: requireString(data, "delta", frame.event),
					});
					return;
				}
				case "TOOL_CALL_END": {
					requireCursor(frame);
					toolEvents.push({
						kind: "tool_call_end",
						toolCallId: requireString(data, "toolCallId", frame.event),
					});
					return;
				}
				case "TOOL_CALL_RESULT": {
					requireCursor(frame);
					if (data.role !== "tool") {
						throw new Error(`invalid ${frame.event} frame`);
					}
					toolEvents.push({
						kind: "tool_call_result",
						messageId: requireString(data, "messageId", frame.event),
						toolCallId: requireString(data, "toolCallId", frame.event),
						content: requireString(data, "content", frame.event),
					});
					return;
				}
				case "CUSTOM": {
					requireCursor(frame);
					toolEvents.push({
						kind: "custom",
						name: requireString(data, "name", frame.event),
						value: data.value,
					});
					return;
				}
				case "done":
				case "canceled":
				case "error":
					requireCursor(frame);
					if (frame.event === "error") {
						requireString(data, "message", frame.event);
					}
					for (const [messageId, message] of messages) {
						if (message.provisional) messages.delete(messageId);
					}
					terminal = frame.event;
					return;
				default:
					throw new Error(`unsupported client event ${frame.event}`);
			}
		},
		snapshot() {
			return {
				messages: [...messages.values()].map(
					({ messageId, text, provisional }) => ({
						messageId,
						text,
						provisional,
					}),
				),
				toolEvents: [...toolEvents],
				terminal,
			};
		},
	};
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!isPlainRecord(value)) {
		throw new Error("client frame data must be an object");
	}
	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
	data: Record<string, unknown>,
	field: string,
	event: string,
): string {
	const value = data[field];
	if (typeof value !== "string") throw new Error(`invalid ${event} frame`);
	return value;
}

function requireCursor(frame: ClientContractFrame): void {
	if (frame.id === undefined || frame.id === "") {
		throw new Error(`${frame.event} must carry a durable cursor`);
	}
}
