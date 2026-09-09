import { type UiNode, validateUiPayload } from "@mymemo/ui-catalog";
import { z } from "zod";
import type { ArtifactChanges } from "./artifacts";

// Claude Agent SDK 0.3.251 ModelUsage; USD values are SDK estimates.
const ModelUsage = z.record(
	z.string(),
	z.looseObject({
		inputTokens: z.number().nonnegative(),
		outputTokens: z.number().nonnegative(),
		cacheReadInputTokens: z.number().nonnegative(),
		cacheCreationInputTokens: z.number().nonnegative(),
		webSearchRequests: z.number().nonnegative(),
		costUSD: z.number().nonnegative(),
		contextWindow: z.number().nonnegative(),
		maxOutputTokens: z.number().nonnegative(),
		canonicalModel: z.string().optional(),
		provider: z.string().optional(),
		costBasis: z.enum(["list", "managed", "unknown"]).optional(),
	}),
);

export type DataPart =
	| {
			type: "data-generative-ui";
			id: string;
			data: { version: 1; payload: UiNode };
	  }
	| { type: "data-artifacts"; id: string; data: ArtifactChanges };

export interface MessageMetadata {
	turnId: string;
	requestId: string;
	status: "processing" | "done" | "error";
	startedAt: string;
	endedAt?: string;
	errorCode?: string;
	modelUsage?: z.infer<typeof ModelUsage>;
}
type ToolName =
	| "Bash"
	| "Read"
	| "Write"
	| "Edit"
	| "Glob"
	| "Grep"
	| "ListDocuments"
	| "SearchDocuments"
	| "LoadDocuments";
interface ToolOutput {
	value: string;
	truncated: boolean;
	totalBytes: number;
}
interface ToolPart {
	type: `tool-${ToolName}`;
	toolCallId: string;
	input: unknown;
	state: "input-available" | "output-available" | "output-error";
	output?: ToolOutput;
	errorText?: string;
}
export interface AssistantMessage {
	id: string;
	role: "assistant";
	metadata: MessageMetadata;
	parts: Array<
		| DataPart
		| ToolPart
		| { type: "step-start" }
		| { type: "text"; text: string; state: "streaming" | "done" }
	>;
}
export type TextStreamChunk =
	| DataPart
	| { type: "start"; messageId: string; messageMetadata: MessageMetadata }
	| { type: "start-step" | "finish-step" | "finish" }
	| { type: "text-start" | "text-end"; id: string }
	| { type: "text-delta"; id: string; delta: string }
	| { type: "message-metadata"; messageMetadata: MessageMetadata }
	| { type: "error"; errorText: string }
	| { type: "tool-input-start"; toolCallId: string; toolName: ToolName }
	| {
			type: "tool-input-available";
			toolCallId: string;
			toolName: ToolName;
			input: unknown;
	  }
	| { type: "tool-output-available"; toolCallId: string; output: ToolOutput }
	| { type: "tool-output-error"; toolCallId: string; errorText: string };

function toolOutput(content: unknown): ToolOutput {
	const value =
		typeof content === "string" ? content : JSON.stringify(content ?? "");
	const bytes = new TextEncoder().encode(value);
	return {
		value: new TextDecoder().decode(bytes.subarray(0, 8192), {
			stream: bytes.length > 8192,
		}),
		truncated: bytes.length > 8192,
		totalBytes: bytes.length,
	};
}

const toolNames = new Map<string, ToolName>(
	Object.entries({
		bash: "Bash",
		read: "Read",
		write: "Write",
		edit: "Edit",
		glob: "Glob",
		grep: "Grep",
		listdocuments: "ListDocuments",
		searchdocuments: "SearchDocuments",
		loaddocuments: "LoadDocuments",
	}),
);

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function sdkError(message: Record<string, unknown>): string {
	if (
		message.terminal_reason === "aborted_streaming" ||
		message.terminal_reason === "aborted_tools"
	)
		return "budget_exceeded";
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
	let fatalRuntimeError = false;
	const tools = new Map<string, ToolPart>();
	const presentations = new Map<string, unknown>();
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
		get hasResult() {
			return result;
		},
		get fatalRuntimeError() {
			return fatalRuntimeError;
		},
		artifacts(data: ArtifactChanges) {
			if (finished || (!data.artifacts.length && !data.removed.length)) return;
			endStep();
			const part: DataPart = { type: "data-artifacts", id: input.turnId, data };
			message.parts.push(part);
			emit(part);
		},
		push(raw: unknown) {
			if (finished) return;
			const value = object(raw);
			if (value.type === "mymemo.error") {
				fatalRuntimeError = true;
				errorCode =
					typeof value.code === "string" ? value.code : "internal_error";
				return;
			}
			if (value.type === "result") {
				result = true;
				const usage = ModelUsage.safeParse(value.modelUsage);
				if (usage.success)
					message.metadata = { ...message.metadata, modelUsage: usage.data };
				if (value.is_error || value.subtype !== "success")
					errorCode ??= sdkError(value);
				return;
			}
			if (value.type === "assistant" && value.error) {
				errorCode = sdkError(value);
				return;
			}
			if (value.type === "assistant" || value.type === "user") {
				const content = object(value.message).content;
				for (const rawBlock of Array.isArray(content) ? content : []) {
					const block = object(rawBlock);
					if (value.type === "assistant" && block.type === "tool_use") {
						if (
							["PresentUI", "mcp__ui__present"].includes(String(block.name)) &&
							typeof block.id === "string"
						) {
							presentations.set(block.id, block.input);
							continue;
						}
						const name =
							typeof block.name === "string"
								? toolNames.get(
										block.name
											.replace(/^mcp__(?:hand|docs)__/, "")
											.toLowerCase(),
									)
								: undefined;
						if (!name || typeof block.id !== "string" || tools.has(block.id))
							continue;
						const part: ToolPart = {
							type: `tool-${name}`,
							toolCallId: block.id,
							input: block.input,
							state: "input-available",
						};
						tools.set(block.id, part);
						message.parts.push(part);
						emit({
							type: "tool-input-start",
							toolCallId: block.id,
							toolName: name,
						});
						emit({
							type: "tool-input-available",
							toolCallId: block.id,
							toolName: name,
							input: block.input,
						});
					} else if (value.type === "user" && block.type === "tool_result") {
						if (
							typeof block.tool_use_id === "string" &&
							presentations.has(block.tool_use_id)
						) {
							const payload = presentations.get(block.tool_use_id);
							presentations.delete(block.tool_use_id);
							if (!block.is_error) {
								const validated = validateUiPayload(payload);
								if (!validated.ok) throw new Error("Invalid PresentUI result");
								const part: DataPart = {
									type: "data-generative-ui",
									id: crypto.randomUUID(),
									data: { version: 1, payload: validated.value },
								};
								message.parts.push(part);
								emit(part);
							}
							continue;
						}
						const part =
							typeof block.tool_use_id === "string"
								? tools.get(block.tool_use_id)
								: undefined;
						if (!part || part.state !== "input-available") continue;
						const output = toolOutput(block.content);
						if (block.is_error) {
							part.state = "output-error";
							part.errorText = output.value;
							emit({
								type: "tool-output-error",
								toolCallId: part.toolCallId,
								errorText: output.value,
							});
						} else {
							part.state = "output-available";
							part.output = output;
							emit({
								type: "tool-output-available",
								toolCallId: part.toolCallId,
								output,
							});
						}
					}
				}
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
