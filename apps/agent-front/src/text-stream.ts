export interface MessageMetadata {
	turnId: string;
	requestId: string;
	status: "processing" | "done" | "error";
	startedAt: string;
	endedAt?: string;
	errorCode?: string;
}
export interface AssistantMessage {
	id: string;
	role: "assistant";
	metadata: MessageMetadata;
	parts: Array<
		| { type: "step-start" }
		| { type: "text"; text: string; state: "streaming" | "done" }
	>;
}
export type TextStreamChunk =
	| { type: "start"; messageId: string; messageMetadata: MessageMetadata }
	| { type: "start-step" | "finish-step" | "finish" }
	| { type: "text-start" | "text-end"; id: string }
	| { type: "text-delta"; id: string; delta: string }
	| { type: "message-metadata"; messageMetadata: MessageMetadata }
	| { type: "error"; errorText: string };

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function sdkError(message: Record<string, unknown>): string {
	if (message.terminal_reason === "aborted_streaming") return "budget_exceeded";
	const detail = JSON.stringify([
		message.subtype,
		message.error,
		message.errors,
		message.status,
		object(message.message).content,
	]);
	if (/\b(402|429)\b|rate_limit|billing_error/i.test(detail))
		return "quota_exceeded";
	if (/\babort(ed)?\b|\binterrupt(ed)?\b|error_max_budget_usd/i.test(detail))
		return "budget_exceeded";
	return "internal_error";
}

// Partial SDK events are the text source; assistant snapshots repeat them.
export function createTextStream(input: {
	messageId: string;
	turnId: string;
	requestId: string;
	startedAt: string;
	emit: (chunk: TextStreamChunk) => void;
}) {
	const { emit } = input;
	const message: AssistantMessage = {
		id: input.messageId,
		role: "assistant",
		metadata: {
			turnId: input.turnId,
			requestId: input.requestId,
			status: "processing",
			startedAt: input.startedAt,
		},
		parts: [],
	};
	let step = 0;
	let stepOpen = false;
	let result = false;
	let errorCode: string | undefined;
	let finished = false;
	const texts = new Map<
		unknown,
		{
			id: string;
			part: Extract<AssistantMessage["parts"][number], { type: "text" }>;
		}
	>();
	const endText = (index: unknown) => {
		const text = texts.get(index);
		if (!text) return;
		text.part.state = "done";
		emit({ type: "text-end", id: text.id });
		texts.delete(index);
	};
	const endStep = () => {
		for (const index of texts.keys()) endText(index);
		if (stepOpen) emit({ type: "finish-step" });
		stepOpen = false;
	};
	emit({
		type: "start",
		messageId: message.id,
		messageMetadata: message.metadata,
	});
	return {
		message,
		push(raw: unknown) {
			if (finished) return;
			const value = object(raw);
			if (value.type === "mymemo.error") {
				errorCode =
					typeof value.code === "string" ? value.code : "internal_error";
				return;
			}
			if (value.type === "result") {
				result = true;
				if (value.is_error || value.subtype !== "success")
					errorCode ??= sdkError(value);
				return;
			}
			if (value.type === "assistant" && value.error) {
				errorCode = sdkError(value);
				return;
			}
			if (value.type !== "stream_event") return;
			const event = object(value.event);
			switch (event.type) {
				case "message_start":
					if (stepOpen) errorCode = "internal_error";
					endStep();
					step++;
					stepOpen = true;
					message.parts.push({ type: "step-start" });
					emit({ type: "start-step" });
					break;
				case "content_block_start": {
					const block = object(event.content_block);
					if (block.type !== "text") break;
					if (!stepOpen || texts.has(event.index)) {
						errorCode = "internal_error";
						break;
					}
					const part: Extract<
						AssistantMessage["parts"][number],
						{ type: "text" }
					> = { type: "text", text: "", state: "streaming" };
					const id = `${message.id}:${step}:${event.index}`;
					texts.set(event.index, { id, part });
					message.parts.push(part);
					emit({ type: "text-start", id });
					if (typeof block.text === "string" && block.text) {
						part.text = block.text;
						emit({ type: "text-delta", id, delta: block.text });
					}
					break;
				}
				case "content_block_delta": {
					const delta = object(event.delta);
					if (delta.type !== "text_delta") break;
					const text = texts.get(event.index);
					if (!text || typeof delta.text !== "string") {
						errorCode = "internal_error";
						break;
					}
					text.part.text += delta.text;
					emit({ type: "text-delta", id: text.id, delta: delta.text });
					break;
				}
				case "content_block_stop":
					endText(event.index);
					break;
				case "message_stop":
					if (!stepOpen || texts.size) errorCode = "internal_error";
					endStep();
					break;
			}
		},
		finish(failure?: string) {
			if (finished) return message;
			finished = true;
			errorCode =
				failure ??
				errorCode ??
				(!result || stepOpen ? "internal_error" : undefined);
			endStep();
			message.metadata = {
				...message.metadata,
				status: errorCode ? "error" : "done",
				...(errorCode ? { errorCode } : {}),
				endedAt: new Date().toISOString(),
			};
			emit({ type: "message-metadata", messageMetadata: message.metadata });
			emit(
				errorCode
					? { type: "error", errorText: errorCode }
					: { type: "finish" },
			);
			return message;
		},
	};
}
