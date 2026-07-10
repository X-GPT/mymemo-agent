import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantTextPayload } from "@mymemo/agent-db/run-events";

type ContentBlockDelta = Extract<
	Extract<SDKMessage, { type: "stream_event" }>["event"],
	{ type: "content_block_delta" }
>["delta"];

interface ActiveBlock {
	index: number;
	type: string;
	completed: boolean;
}

interface ActiveEnvelope {
	messageId: string;
	providerMessageId: string;
	activeBlock: ActiveBlock | null;
	nextBlockIndex: number;
	messageDeltaSeen: boolean;
	partialText: string;
	completedText: string;
}

export class AssistantEnvelopeProtocolError extends Error {
	override name = "AssistantEnvelopeProtocolError" as const;
}

export interface AssistantMessageAssemblerOptions {
	createMessageId?: () => string;
	onPartialCompleteMismatch?: () => void;
}

/**
 * Deterministically assembles complete Assistant messages from one ordered SDK
 * stream. Partial provider text is evidence only; completed SDK content blocks
 * are the durable source and `message_stop` is the sole commit boundary.
 */
export class AssistantMessageAssembler {
	readonly #createMessageId: () => string;
	readonly #onPartialCompleteMismatch: () => void;
	readonly #issuedMessageIds = new Set<string>();
	#active: ActiveEnvelope | null = null;
	#livePreviewEnabled = true;

	constructor(options: AssistantMessageAssemblerOptions = {}) {
		this.#createMessageId = options.createMessageId ?? randomUUID;
		this.#onPartialCompleteMismatch =
			options.onPartialCompleteMismatch ?? (() => {});
	}

	get livePreviewEnabled(): boolean {
		return this.#livePreviewEnabled;
	}

	accept(message: SDKMessage): AssistantTextPayload | null {
		if (message.type === "assistant") {
			this.#acceptCompletedBlock(message);
			return null;
		}
		if (message.type !== "stream_event") return null;

		const event = message.event;
		switch (event.type) {
			case "message_start":
				this.#startEnvelope(event.message.id);
				return null;
			case "content_block_start":
				this.#startBlock(event.index, event.content_block.type);
				return null;
			case "content_block_delta":
				this.#acceptDelta(event.index, event.delta);
				return null;
			case "content_block_stop":
				this.#stopBlock(event.index);
				return null;
			case "message_delta": {
				const active = this.#requireEnvelope("message_delta");
				if (active.activeBlock !== null) {
					this.#violation("message_delta arrived before content_block_stop");
				}
				if (active.messageDeltaSeen) {
					this.#violation("message_delta appeared more than once");
				}
				active.messageDeltaSeen = true;
				return null;
			}
			case "message_stop":
				return this.#stopEnvelope();
		}
	}

	abandon(): void {
		this.#active = null;
	}

	finish(): void {
		if (this.#active !== null) {
			this.#violation("SDK stream ended before message_stop");
		}
	}

	#startEnvelope(providerMessageId: string): void {
		if (this.#active !== null) {
			this.#violation("message_start overlapped an active envelope");
		}
		if (
			typeof providerMessageId !== "string" ||
			providerMessageId.length === 0
		) {
			this.#violation("message_start had no provider message id");
		}
		const messageId = this.#createMessageId();
		if (
			typeof messageId !== "string" ||
			messageId.length === 0 ||
			this.#issuedMessageIds.has(messageId)
		) {
			this.#violation("message id factory returned an invalid id");
		}
		this.#issuedMessageIds.add(messageId);
		this.#active = {
			messageId,
			providerMessageId,
			activeBlock: null,
			nextBlockIndex: 0,
			messageDeltaSeen: false,
			partialText: "",
			completedText: "",
		};
	}

	#startBlock(index: number, type: string): void {
		const active = this.#requireEnvelope("content_block_start");
		if (active.messageDeltaSeen) {
			this.#violation("content_block_start arrived after message_delta");
		}
		if (active.activeBlock !== null) {
			this.#violation("content_block_start overlapped an active block");
		}
		if (index !== active.nextBlockIndex) {
			this.#violation("content block index was not contiguous");
		}
		if (typeof type !== "string" || type.length === 0) {
			this.#violation("content block had no type");
		}
		active.activeBlock = { index, type, completed: false };
	}

	#acceptDelta(index: number, delta: ContentBlockDelta): void {
		const block = this.#requireBlock("content_block_delta", index);
		if (block.completed) {
			this.#violation("content block delta arrived after assistant completion");
		}
		if (delta.type === "text_delta") {
			if (block.type !== "text" || typeof delta.text !== "string") {
				this.#violation("text delta did not match its content block");
			}
			const active = this.#active;
			if (active !== null) active.partialText += delta.text;
			return;
		}
		if (block.type === "text") {
			this.#violation("non-text delta arrived for a text block");
		}
	}

	#acceptCompletedBlock(
		message: Extract<SDKMessage, { type: "assistant" }>,
	): void {
		const active = this.#requireEnvelope("assistant content block");
		if (message.message.id !== active.providerMessageId) {
			this.#violation("assistant content block named a different envelope");
		}
		const block = active.activeBlock;
		if (block === null) {
			this.#violation("assistant content block arrived outside a block");
		}
		if (block.completed) {
			this.#violation("content block had multiple assistant completions");
		}
		const content = message.message.content;
		if (!Array.isArray(content) || content.length !== 1) {
			this.#violation("assistant completion did not contain exactly one block");
		}
		const completed = content[0];
		if (!completed || completed.type !== block.type) {
			this.#violation("assistant completion type did not match stream block");
		}
		block.completed = true;
		if (completed.type === "text") {
			if (typeof completed.text !== "string") {
				this.#violation("completed text block had no string text");
			}
			active.completedText += completed.text;
		}
	}

	#stopBlock(index: number): void {
		const block = this.#requireBlock("content_block_stop", index);
		if (!block.completed) {
			this.#violation("content block stopped before assistant completion");
		}
		const active = this.#active;
		if (active === null) return;
		active.activeBlock = null;
		active.nextBlockIndex++;
	}

	#stopEnvelope(): AssistantTextPayload | null {
		const active = this.#requireEnvelope("message_stop");
		if (active.activeBlock !== null) {
			this.#violation("message_stop arrived before content_block_stop");
		}
		if (active.partialText !== active.completedText) {
			this.#livePreviewEnabled = false;
			this.#onPartialCompleteMismatch();
		}
		this.#active = null;
		return active.completedText.length > 0
			? { messageId: active.messageId, text: active.completedText }
			: null;
	}

	#requireEnvelope(eventName: string): ActiveEnvelope {
		if (this.#active === null) {
			this.#violation(`${eventName} arrived without message_start`);
		}
		return this.#active;
	}

	#requireBlock(eventName: string, index: number): ActiveBlock {
		const active = this.#requireEnvelope(eventName);
		if (active.activeBlock === null) {
			this.#violation(`${eventName} arrived without content_block_start`);
		}
		if (active.activeBlock.index !== index) {
			this.#violation(`${eventName} named the wrong content block`);
		}
		return active.activeBlock;
	}

	#violation(message: string): never {
		this.#active = null;
		throw new AssistantEnvelopeProtocolError(message);
	}
}
