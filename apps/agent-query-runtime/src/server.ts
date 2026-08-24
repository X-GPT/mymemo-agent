import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import { z } from "zod";

export const AGENTCORE_RUNTIME_SESSION_HEADER =
	"x-amzn-bedrock-agentcore-runtime-session-id";

const MAX_INVOCATION_BYTES = 64 * 1024;
const identifier = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
const agentQueryRequest = z.strictObject({
	version: z.literal(1),
	conversationId: identifier,
	conversationEpoch: z.number().int().nonnegative(),
	prompt: z.string().min(1).max(50_000),
	model: z
		.string()
		.min(1)
		.max(256)
		.refine((value) => value.trim().length > 0),
	agentSessionId: z.string().min(1).max(2_048).optional(),
});

export type ResponseAuthorityVerifier = (authority: {
	conversationId: string;
	conversationEpoch: number;
}) => Promise<void>;

export type AgentQueryRuntimeDependencies = {
	query(input: { prompt: string; options: Options }): AsyncIterable<SDKMessage>;
	verifyResponseAuthority: ResponseAuthorityVerifier;
};

class InvalidInvocationError extends Error {
	override readonly name = "InvalidInvocationError";
}

async function readBoundedBody(request: Request): Promise<string> {
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > MAX_INVOCATION_BYTES) {
		throw new InvalidInvocationError("AgentCore invocation body is too large");
	}
	if (!request.body) return "";

	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let body = "";
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > MAX_INVOCATION_BYTES) {
				throw new InvalidInvocationError(
					"AgentCore invocation body is too large",
				);
			}
			body += decoder.decode(part.value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function parseRequest(request: Request): Promise<AgentQueryRequest> {
	let decoded: unknown;
	try {
		decoded = JSON.parse(await readBoundedBody(request));
	} catch (error) {
		if (error instanceof InvalidInvocationError) throw error;
		throw new InvalidInvocationError("invalid Agent query request");
	}
	const parsed = agentQueryRequest.safeParse(decoded);
	if (!parsed.success) {
		throw new InvalidInvocationError("invalid Agent query request");
	}
	return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isControlledTextEvent(message: SDKMessage): boolean {
	if (message.type !== "stream_event" || !isRecord(message.event)) return false;
	const event = message.event;
	switch (event.type) {
		case "message_start":
		case "message_stop":
		case "content_block_stop":
			return true;
		case "content_block_start":
			return (
				isRecord(event.content_block) && event.content_block.type === "text"
			);
		case "content_block_delta":
			return isRecord(event.delta) && event.delta.type === "text_delta";
		default:
			return false;
	}
}

function isValidResult(message: SDKMessage): boolean {
	return (
		message.type === "result" &&
		typeof message.session_id === "string" &&
		message.session_id.length > 0 &&
		typeof message.subtype === "string" &&
		typeof message.is_error === "boolean"
	);
}

function createNdjsonStream(messages: AsyncIterable<SDKMessage>) {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const message of messages) {
					if (message.type === "result") {
						if (!isValidResult(message)) {
							throw new Error("invalid terminal Claude result");
						}
						controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
						controller.close();
						return;
					}
					if (isControlledTextEvent(message)) {
						controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
					}
				}
				throw new Error("Claude stream ended before its terminal result");
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

function jsonError(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

export function createAgentQueryRequestHandler(
	dependencies: AgentQueryRuntimeDependencies,
) {
	return async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		if (pathname === "/ping") {
			if (request.method !== "GET") return jsonError("method not allowed", 405);
			return Response.json({ status: "Healthy" });
		}
		if (pathname !== "/invocations") return jsonError("not found", 404);
		if (request.method !== "POST") return jsonError("method not allowed", 405);
		if (!request.headers.get("content-type")?.startsWith("application/json")) {
			return jsonError("content type must be application/json", 415);
		}

		try {
			const runtimeSessionId = request.headers.get(
				AGENTCORE_RUNTIME_SESSION_HEADER,
			);
			if (
				!runtimeSessionId ||
				!identifier.safeParse(runtimeSessionId).success
			) {
				throw new InvalidInvocationError(
					"Runtime session identity is required",
				);
			}
			const input = await parseRequest(request);
			if (runtimeSessionId !== input.conversationId) {
				throw new InvalidInvocationError("Runtime session mismatch");
			}
			await dependencies.verifyResponseAuthority({
				conversationId: input.conversationId,
				conversationEpoch: input.conversationEpoch,
			});
			const messages = dependencies.query({
				prompt: input.prompt,
				options: {
					model: input.model,
					includePartialMessages: true,
					cwd: `/workspace/conversations/${input.conversationId}`,
					...(input.agentSessionId ? { resume: input.agentSessionId } : {}),
				},
			});
			return new Response(createNdjsonStream(messages), {
				status: 200,
				headers: { "content-type": "application/x-ndjson" },
			});
		} catch (error) {
			if (error instanceof InvalidInvocationError) {
				return jsonError(error.message, 400);
			}
			return jsonError("AgentCore invocation failed", 503);
		}
	};
}
