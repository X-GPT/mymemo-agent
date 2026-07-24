export interface ClientContractFrame {
	event: string;
	data: unknown;
}

export interface ClientContractMessage {
	messageId: string;
	text: string;
	provisional: boolean;
}

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

export interface ClientContractFixture {
	receive(frame: ClientContractFrame): void;
	snapshot(): ClientContractSnapshot;
}

export function createClientContractFixture(): ClientContractFixture {
	const messages = new Map<string, ClientContractMessage>();
	const toolEvents: ClientContractToolEvent[] = [];
	let terminal: ClientContractTerminal | undefined;

	return {
		receive(frame) {
			const data = requireRecord(frame.data);
			if (data.type !== frame.event) {
				throw new Error(`invalid ${frame.event} frame`);
			}
			if (terminal !== undefined) return;

			switch (frame.event) {
				case "RUN_STARTED":
					requireString(data, "threadId", frame.event);
					requireString(data, "runId", frame.event);
					return;
				case "TEXT_MESSAGE_START": {
					const messageId = requireString(data, "messageId", frame.event);
					messages.set(messageId, {
						messageId,
						text: "",
						provisional: true,
					});
					return;
				}
				case "TEXT_MESSAGE_CONTENT": {
					const messageId = requireString(data, "messageId", frame.event);
					const message = messages.get(messageId);
					if (!message || !message.provisional) {
						throw new Error("TEXT_MESSAGE_CONTENT has no open message");
					}
					message.text += requireString(data, "delta", frame.event);
					return;
				}
				case "TEXT_MESSAGE_END": {
					const messageId = requireString(data, "messageId", frame.event);
					const message = messages.get(messageId);
					if (!message || !message.provisional) {
						throw new Error("TEXT_MESSAGE_END has no open message");
					}
					message.provisional = false;
					return;
				}
				case "TOOL_CALL_START":
					toolEvents.push({
						kind: "tool_call_start",
						toolCallId: requireString(data, "toolCallId", frame.event),
						tool: requireString(data, "toolCallName", frame.event),
						parentMessageId: requireString(
							data,
							"parentMessageId",
							frame.event,
						),
					});
					return;
				case "TOOL_CALL_ARGS":
					toolEvents.push({
						kind: "tool_call_args",
						toolCallId: requireString(data, "toolCallId", frame.event),
						delta: requireString(data, "delta", frame.event),
					});
					return;
				case "TOOL_CALL_END":
					toolEvents.push({
						kind: "tool_call_end",
						toolCallId: requireString(data, "toolCallId", frame.event),
					});
					return;
				case "TOOL_CALL_RESULT":
					toolEvents.push({
						kind: "tool_call_result",
						messageId: requireString(data, "messageId", frame.event),
						toolCallId: requireString(data, "toolCallId", frame.event),
						content: requireString(data, "content", frame.event),
					});
					return;
				case "CUSTOM":
					toolEvents.push({
						kind: "custom",
						name: requireString(data, "name", frame.event),
						value: data.value,
					});
					return;
				case "RUN_FINISHED":
					terminal = "done";
					return;
				case "RUN_CANCELLED":
					for (const [id, message] of messages) {
						if (message.provisional) messages.delete(id);
					}
					terminal = "canceled";
					return;
				case "RUN_ERROR":
					requireString(data, "message", frame.event);
					for (const [id, message] of messages) {
						if (message.provisional) messages.delete(id);
					}
					terminal = "error";
					return;
				default:
					throw new Error(`unsupported client event ${frame.event}`);
			}
		},
		snapshot() {
			return {
				messages: [...messages.values()].map((message) => ({ ...message })),
				toolEvents: [...toolEvents],
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
