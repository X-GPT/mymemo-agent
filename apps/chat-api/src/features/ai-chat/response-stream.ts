import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const MAX_SDK_MESSAGE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

function frame(event: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

async function* readSdkMessages(
	reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
): AsyncGenerator<SDKMessage> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		for (let newline = buffer.indexOf("\n"); newline >= 0; ) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line || encoder.encode(line).byteLength > MAX_SDK_MESSAGE_BYTES) {
				throw new Error("invalid Claude SDK message");
			}
			yield JSON.parse(line) as SDKMessage;
			newline = buffer.indexOf("\n");
		}
		if (encoder.encode(buffer).byteLength > MAX_SDK_MESSAGE_BYTES) {
			throw new Error("Claude SDK message is too large");
		}
	}
	buffer += decoder.decode();
	if (buffer) throw new Error("incomplete Claude SDK message");
}

async function consumeClaudeMessages(input: {
	messages: AsyncIterable<SDKMessage>;
	messageId: string;
	write(chunk: Uint8Array): void;
}): Promise<unknown[]> {
	const textId = `${input.messageId}-text-0`;
	let text = "";
	let textStarted = false;
	let terminal = false;

	input.write(frame({ type: "start", messageId: input.messageId }));
	for await (const message of input.messages) {
		if (message.type === "system") continue;
		if (message.type === "result") {
			if (
				terminal ||
				message.subtype !== "success" ||
				message.is_error ||
				message.session_id.length === 0
			) {
				throw new Error("invalid terminal Claude result");
			}
			terminal = true;
			continue;
		}
		if (terminal) throw new Error("invalid Claude event after result");
		if (message.type === "stream_event") {
			const event = message.event;
			if (
				event.type === "content_block_delta" &&
				event.delta.type === "text_delta"
			) {
				if (!textStarted) {
					textStarted = true;
					input.write(frame({ type: "text-start", id: textId }));
				}
				text += event.delta.text;
				input.write(
					frame({ type: "text-delta", id: textId, delta: event.delta.text }),
				);
			}
			continue;
		}
		if (message.type === "assistant") {
			if (message.error || message.aborted) {
				throw new Error("Claude Assistant message failed");
			}
			continue;
		}
		throw new Error("invalid Claude event");
	}
	if (!terminal || !textStarted) {
		throw new Error("Claude stream ended before completion");
	}
	input.write(frame({ type: "text-end", id: textId }));
	return [{ type: "text", text, state: "done" }];
}

export function toAiSdkResponse(
	upstream: Response,
	complete: (input: { messageId: string; parts: unknown[] }) => Promise<void>,
): Response {
	if (!upstream.ok || !upstream.body) return upstream;
	const messageId = randomUUID();
	const reader = upstream.body.getReader();
	let connected = true;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			void (async () => {
				const parts = await consumeClaudeMessages({
					messages: readSdkMessages(reader),
					messageId,
					write: (chunk) => {
						if (connected) controller.enqueue(chunk);
					},
				});
				await complete({ messageId, parts });
				if (!connected) return;
				controller.enqueue(
					encoder.encode(
						'data: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n',
					),
				);
				controller.close();
			})().catch((error) => {
				if (connected) controller.error(error);
			});
		},
		cancel() {
			connected = false;
		},
	});
	const headers = new Headers(upstream.headers);
	headers.delete("content-length");
	headers.set("content-type", "text/event-stream");
	headers.set("x-vercel-ai-ui-message-stream", "v1");
	return new Response(stream, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}
