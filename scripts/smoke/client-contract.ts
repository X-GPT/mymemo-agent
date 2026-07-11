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

export type ClientContractTerminal = "done" | "canceled" | "error";

export interface ClientContractSnapshot {
	messages: ClientContractMessage[];
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
	let terminal: ClientContractTerminal | undefined;

	return {
		receive(frame) {
			const data = requireRecord(frame.data);
			if (data.type !== frame.event) {
				throw new Error(`invalid ${frame.event} frame`);
			}
			if (
				terminal !== undefined &&
				(frame.event === "text_delta" || frame.event === "text_commit")
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
				terminal,
			};
		},
	};
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("client frame data must be an object");
	}
	return value as Record<string, unknown>;
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
