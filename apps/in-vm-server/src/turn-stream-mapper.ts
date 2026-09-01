import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UIDataTypes, UIMessageChunk, UIMessagePart, UITools } from "ai";

/**
 * Maps one Turn's Claude Agent SDK stream to stock AI SDK v7 UIMessage chunks
 * and the Turn's durable parts (spec #654, mapping table amended on #662): the
 * whole Turn is ONE assistant UIMessage; each provider response is a Step
 * (`start-step`/`finish-step`) inside it. The pinned SDK protocol under
 * `includePartialMessages: true` frames a provider call as `message_start` …
 * per-content-block `assistant` completions … `message_stop` (the same
 * envelope agentcore-runtime's assembler consumes); completed content blocks
 * are the durable source, stream deltas are live-display evidence only.
 *
 * The mapper is pure state: it emits actions, and the caller owns the
 * commit-before-publish ordering — a `step-commit` action means "upsert these
 * parts, THEN publish finish-step", and a `terminal` action means "final
 * upsert, flip the Turn status, THEN publish this chunk".
 */

/** The SDK stream violated the pinned envelope protocol; the Turn must end
 * `error`, never `done`. */
export class TurnStreamProtocolError extends Error {
	override name = "TurnStreamProtocolError" as const;
}

export type TurnUIMessagePart = UIMessagePart<UIDataTypes, UITools>;

export type MapperAction =
	| { kind: "chunk"; chunk: UIMessageChunk }
	| {
			/** A Step completed: upsert `parts` (the full committed snapshot,
			 * this Step included) before publishing `finish-step`. */
			kind: "step-commit";
			parts: TurnUIMessagePart[];
	  }
	| {
			/** The Turn ended: final upsert of `parts`, terminalize to
			 * `outcome`, then publish `chunk` — in that order. */
			kind: "terminal";
			outcome: "done" | "error";
			parts: TurnUIMessagePart[];
			chunk: UIMessageChunk;
	  };

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

/** A streaming text/thinking block whose deltas need an id to ride on. Tool
 * and unknown blocks are never registered — their chunks key on the tool call
 * id, and delta/stop events for an unregistered index are simply ignored. */
interface OpenBlock {
	kind: "text" | "reasoning";
	chunkId: string;
}

/** A committed tool part, mutated in place when its result arrives — the
 * mutation lands durably at the next commit boundary, per "durability follows
 * the Step". */
interface MutableToolPart {
	type: `tool-${string}`;
	toolCallId: string;
	state: "input-available" | "output-available" | "output-error";
	input: unknown;
	output?: unknown;
	errorText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function chunk(value: UIMessageChunk): MapperAction {
	return { kind: "chunk", chunk: value };
}

/** Render a tool_result's content for an errorText field. The content came
 * off the SDK's JSON wire, so it always stringifies. */
function toErrorText(content: unknown): string {
	if (typeof content === "string") return content;
	return JSON.stringify(content) ?? "tool failed";
}

export class TurnStreamMapper {
	/** Parts of completed Steps, in order — the durable UIMessage snapshot. */
	readonly #committedParts: TurnUIMessagePart[] = [];
	readonly #toolPartsByCallId = new Map<string, MutableToolPart>();
	#currentStep: {
		blocks: Map<number, OpenBlock>;
		parts: TurnUIMessagePart[];
	} | null = null;
	#nextChunkId = 0;
	#terminalSeen = false;

	/** The committed-Steps snapshot, for the caller's failure path. */
	get committedParts(): TurnUIMessagePart[] {
		return this.#committedParts;
	}

	accept(message: SDKMessage): MapperAction[] {
		if (this.#terminalSeen) return [];
		switch (message.type) {
			case "stream_event":
				// Subagent-internal traffic never enters the Turn's UIMessage.
				if (message.parent_tool_use_id !== null) return [];
				return this.#acceptStreamEvent(message.event);
			case "assistant":
				if (message.parent_tool_use_id !== null) return [];
				return this.#acceptAssistantMessage(message.message.content);
			case "user":
				if (message.parent_tool_use_id !== null) return [];
				return this.#acceptToolResults(message.message.content);
			case "result":
				return this.#acceptResult(message);
			default:
				// Status/system messages carry no UIMessage content.
				return [];
		}
	}

	#acceptStreamEvent(event: StreamEvent): MapperAction[] {
		switch (event.type) {
			case "message_start": {
				if (this.#currentStep !== null) {
					this.#violation("message_start overlapped an open Step");
				}
				this.#currentStep = { blocks: new Map(), parts: [] };
				return [chunk({ type: "start-step" })];
			}
			case "content_block_start": {
				const step = this.#requireStep("content_block_start");
				const contentBlock = event.content_block;
				if (contentBlock.type === "text") {
					const chunkId = `blk_${this.#nextChunkId++}`;
					step.blocks.set(event.index, { kind: "text", chunkId });
					return [chunk({ type: "text-start", id: chunkId })];
				}
				if (contentBlock.type === "thinking") {
					const chunkId = `blk_${this.#nextChunkId++}`;
					step.blocks.set(event.index, { kind: "reasoning", chunkId });
					return [chunk({ type: "reasoning-start", id: chunkId })];
				}
				if (contentBlock.type === "tool_use") {
					return [
						chunk({
							type: "tool-input-start",
							toolCallId: contentBlock.id,
							toolName: contentBlock.name,
						}),
					];
				}
				return [];
			}
			case "content_block_delta": {
				const block = this.#currentStep?.blocks.get(event.index);
				if (!block) return [];
				const delta = event.delta;
				if (block.kind === "text" && delta.type === "text_delta") {
					return [
						chunk({ type: "text-delta", id: block.chunkId, delta: delta.text }),
					];
				}
				if (block.kind === "reasoning" && delta.type === "thinking_delta") {
					return [
						chunk({
							type: "reasoning-delta",
							id: block.chunkId,
							delta: delta.thinking,
						}),
					];
				}
				// Tool input arrives complete (not incrementally); signature and
				// unknown deltas have no UIMessage representation.
				return [];
			}
			case "content_block_stop": {
				const step = this.#currentStep;
				const block = step?.blocks.get(event.index);
				if (!step || !block) return [];
				step.blocks.delete(event.index);
				if (block.kind === "text") {
					return [chunk({ type: "text-end", id: block.chunkId })];
				}
				return [chunk({ type: "reasoning-end", id: block.chunkId })];
			}
			case "message_stop": {
				const step = this.#requireStep("message_stop");
				this.#committedParts.push({ type: "step-start" }, ...step.parts);
				this.#currentStep = null;
				return [{ kind: "step-commit", parts: this.#committedParts }];
			}
			default:
				return [];
		}
	}

	/**
	 * A top-level `assistant` SDK message completes content blocks of the open
	 * provider envelope (one block per message under partial streaming). The
	 * completed blocks — not the accumulated deltas — become the Step's parts.
	 */
	#acceptAssistantMessage(content: unknown): MapperAction[] {
		const step = this.#requireStep("assistant message");
		if (!Array.isArray(content)) {
			this.#violation("assistant message carried no content array");
		}
		const actions: MapperAction[] = [];
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") {
				step.parts.push({ type: "text", text: block.text, state: "done" });
			} else if (
				block.type === "thinking" &&
				typeof block.thinking === "string"
			) {
				step.parts.push({
					type: "reasoning",
					text: block.thinking,
					state: "done",
				});
			} else if (
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				const part: MutableToolPart = {
					type: `tool-${block.name}`,
					toolCallId: block.id,
					state: "input-available",
					input: block.input,
				};
				this.#toolPartsByCallId.set(block.id, part);
				step.parts.push(part as TurnUIMessagePart);
				actions.push(
					chunk({
						type: "tool-input-available",
						toolCallId: block.id,
						toolName: block.name,
						input: block.input,
					}),
				);
			}
			// redacted_thinking and unknown block types have no UIMessage
			// representation; they stay out of the durable parts.
		}
		return actions;
	}

	#acceptToolResults(content: unknown): MapperAction[] {
		if (!Array.isArray(content)) return [];
		const actions: MapperAction[] = [];
		for (const block of content) {
			if (
				!isRecord(block) ||
				block.type !== "tool_result" ||
				typeof block.tool_use_id !== "string"
			) {
				continue;
			}
			const part = this.#toolPartsByCallId.get(block.tool_use_id);
			if (!part) continue;
			const output = block.content ?? null;
			if (block.is_error === true) {
				const errorText = toErrorText(output);
				part.state = "output-error";
				part.errorText = errorText;
				actions.push(
					chunk({
						type: "tool-output-error",
						toolCallId: block.tool_use_id,
						errorText,
					}),
				);
			} else {
				part.state = "output-available";
				part.output = output;
				actions.push(
					chunk({
						type: "tool-output-available",
						toolCallId: block.tool_use_id,
						output,
					}),
				);
			}
		}
		return actions;
	}

	#acceptResult(
		message: Extract<SDKMessage, { type: "result" }>,
	): MapperAction[] {
		this.#terminalSeen = true;
		// A Step in flight when the Turn dies is never persisted.
		this.#currentStep = null;
		// A "success" result still ends the Turn `error` when the turn died on
		// an API error: the SDK signals that as subtype "success" with
		// `is_error: true` and the error text in `result` (sdk.d.ts, 0.3.251).
		if (message.subtype === "success" && !message.is_error) {
			return [
				{
					kind: "terminal",
					outcome: "done",
					parts: this.#committedParts,
					chunk: { type: "finish", messageMetadata: { status: "done" } },
				},
			];
		}
		const errorText =
			message.subtype === "success"
				? message.result || "the turn ended on an API error"
				: message.errors.length > 0
					? message.errors.join("; ")
					: message.subtype;
		return [
			{
				kind: "terminal",
				outcome: "error",
				parts: this.#committedParts,
				chunk: { type: "error", errorText },
			},
		];
	}

	#requireStep(eventName: string): {
		blocks: Map<number, OpenBlock>;
		parts: TurnUIMessagePart[];
	} {
		if (this.#currentStep === null) {
			this.#violation(`${eventName} arrived outside a provider call`);
		}
		return this.#currentStep;
	}

	#violation(message: string): never {
		this.#currentStep = null;
		throw new TurnStreamProtocolError(message);
	}
}
