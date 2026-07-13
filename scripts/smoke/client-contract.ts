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

/** One rendered Tool item (ADR-0009): append-only and self-describing — a
 * result is a separate chronological item, never an update to its invocation. */
export type ClientContractToolEvent =
	| { kind: "tool_use"; tool: string }
	| { kind: "tool_result"; tool: string; isError: boolean };

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
					frame.event === "tool_use" ||
					frame.event === "tool_result")
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
				case "tool_use": {
					requireCursor(frame);
					const tool = requireString(data, "tool", frame.event);
					if (
						!isPlainRecord(data.arguments) ||
						typeof data.truncated !== "boolean"
					) {
						throw new Error(`invalid ${frame.event} frame`);
					}
					toolEvents.push({ kind: "tool_use", tool });
					return;
				}
				case "tool_result": {
					requireCursor(frame);
					const tool = requireString(data, "tool", frame.event);
					if (
						!isPlainRecord(data.result) ||
						typeof data.isError !== "boolean" ||
						typeof data.truncated !== "boolean"
					) {
						throw new Error(`invalid ${frame.event} frame`);
					}
					toolEvents.push({ kind: "tool_result", tool, isError: data.isError });
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
