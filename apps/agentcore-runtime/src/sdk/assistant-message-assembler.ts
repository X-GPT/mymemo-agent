import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageCompletedPayload } from "@mymemo/agent-db/run-events";

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
	completedText: string;
	toolUses: CompletedToolUse[];
}

export class AssistantEnvelopeProtocolError extends Error {
	override name = "AssistantEnvelopeProtocolError" as const;
}

export interface AssistantMessageAssemblerOptions {
	createMessageId?: () => string;
}

/**
 * One completed `tool_use` content block, buffered in content-block order: the
 * SDK id (worker-internal, for associating the later result), the tool name as
 * the SDK reports it, and the raw model-authored input. Nothing here is
 * client-safe yet — allowlisting and projection happen at commit, before any
 * append (ADR-0012).
 */
export interface CompletedToolUse {
	id: string;
	name: string;
	input: unknown;
}

/**
 * What one provider envelope commits at its `message_stop`: the MyMemo message
 * id, optional visible text, and completed tool_use blocks in content-block
 * order. A textless Tool-only envelope still uses the message id as each Tool
 * call's parent identity.
 */
export interface EnvelopeCommit {
	messageId: string;
	text: AssistantMessageCompletedPayload | null;
	toolUses: CompletedToolUse[];
}

export type AssistantAssembly =
	| { type: "partial_text"; messageId: string; text: string }
	| { type: "message_stop"; commit: EnvelopeCommit };

/**
 * The delta subtypes the pinned SDK protocol allows inside each known content
 * block type. A delta arriving in a known block outside its set is structurally
 * impossible, so the envelope is invalid and the Run must fail closed rather
 * than end `done`. Result-style blocks arrive complete and stream no deltas.
 * `citations_delta` appears nowhere: this pipeline never requests citations
 * (documents reach the model as files, ADR-0004), so a citing delta is equally
 * impossible. Unknown block types are deliberately absent — they remain
 * tolerated as opaque interleaved content whose delta vocabulary this pinned
 * protocol cannot know (ADR-0008), except that visible text (`text_delta`)
 * may only ever arrive in a `text` block.
 */
const KNOWN_BLOCK_DELTA_TYPES: ReadonlyMap<string, readonly string[]> = new Map<
	string,
	readonly string[]
>([
	["text", ["text_delta"]],
	["tool_use", ["input_json_delta"]],
	["server_tool_use", ["input_json_delta"]],
	["mcp_tool_use", ["input_json_delta"]],
	["thinking", ["thinking_delta", "signature_delta"]],
	["compaction", ["compaction_delta"]],
	["redacted_thinking", []],
	["container_upload", []],
	["web_search_tool_result", []],
	["web_fetch_tool_result", []],
	["code_execution_tool_result", []],
	["bash_code_execution_tool_result", []],
	["text_editor_code_execution_tool_result", []],
	["tool_search_tool_result", []],
	["mcp_tool_result", []],
]);

/**
 * Deterministically assembles complete Assistant messages from one ordered SDK
 * stream. Partial provider text is evidence only; completed SDK content blocks
 * are the durable source and `message_stop` is the sole commit boundary.
 */
export class AssistantMessageAssembler {
	readonly #createMessageId: () => string;
	readonly #issuedMessageIds = new Set<string>();
	#active: ActiveEnvelope | null = null;

	constructor(options: AssistantMessageAssemblerOptions = {}) {
		this.#createMessageId = options.createMessageId ?? randomUUID;
	}

	accept(message: SDKMessage): AssistantAssembly | null {
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
				return this.#acceptDelta(event.index, event.delta);
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
				return { type: "message_stop", commit: this.#stopEnvelope() };
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
			completedText: "",
			toolUses: [],
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

	#acceptDelta(
		index: number,
		delta: ContentBlockDelta,
	): AssistantAssembly | null {
		const block = this.#requireBlock("content_block_delta", index);
		if (block.completed) {
			this.#violation("content block delta arrived after assistant completion");
		}
		if (delta.type === "text_delta") {
			if (block.type !== "text" || typeof delta.text !== "string") {
				this.#violation("text delta did not match its content block");
			}
			const active = this.#active;
			if (active === null) return null;
			return {
				type: "partial_text",
				messageId: active.messageId,
				text: delta.text,
			};
		}
		const allowedDeltaTypes = KNOWN_BLOCK_DELTA_TYPES.get(block.type);
		if (
			allowedDeltaTypes !== undefined &&
			!allowedDeltaTypes.includes(delta.type)
		) {
			this.#violation("content block delta subtype did not match its block");
		}
		return null;
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
		} else if (completed.type === "tool_use") {
			if (
				typeof completed.id !== "string" ||
				completed.id.length === 0 ||
				typeof completed.name !== "string" ||
				completed.name.length === 0
			) {
				this.#violation("completed tool_use block had no id or name");
			}
			active.toolUses.push({
				id: completed.id,
				name: completed.name,
				input: completed.input,
			});
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

	#stopEnvelope(): EnvelopeCommit {
		const active = this.#requireEnvelope("message_stop");
		if (active.activeBlock !== null) {
			this.#violation("message_stop arrived before content_block_stop");
		}
		this.#active = null;
		return {
			messageId: active.messageId,
			text:
				active.completedText.length > 0
					? { messageId: active.messageId, text: active.completedText }
					: null,
			toolUses: active.toolUses,
		};
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
