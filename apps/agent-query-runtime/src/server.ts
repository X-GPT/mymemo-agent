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

const resultBase = z
	.object({
		type: z.literal("result"),
		duration_ms: z.number().nonnegative(),
		duration_api_ms: z.number().nonnegative(),
		is_error: z.boolean(),
		num_turns: z.number().int().nonnegative(),
		stop_reason: z.string().nullable(),
		total_cost_usd: z.number().nonnegative(),
		usage: z.record(z.string(), z.unknown()),
		modelUsage: z.record(z.string(), z.unknown()),
		permission_denials: z.array(z.unknown()),
		uuid: z.string().min(1),
		session_id: z.string().min(1),
	})
	.passthrough();
const resultMessage = z.discriminatedUnion("subtype", [
	resultBase.extend({
		subtype: z.literal("success"),
		is_error: z.literal(false),
		result: z.string(),
	}),
	resultBase.extend({
		subtype: z.enum([
			"error_during_execution",
			"error_max_turns",
			"error_max_budget_usd",
			"error_max_structured_output_retries",
		]),
		is_error: z.literal(true),
		errors: z.array(z.string()),
	}),
]);

export type ResponseAuthorityVerifier = (authority: {
	conversationId: string;
	conversationEpoch: number;
}) => Promise<void>;

export type AgentQueryRuntimeDependencies = {
	query(input: { prompt: string; options: Options }): AsyncIterable<SDKMessage>;
	prepareWorkingDirectory(path: string): Promise<void>;
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

function createNdjsonStream(messages: AsyncIterable<SDKMessage>) {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (message: SDKMessage) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
			};
			try {
				for await (const message of messages) {
					if (message.type === "result") {
						const result = resultMessage.safeParse(message);
						if (!result.success) {
							throw new Error("invalid terminal Claude result");
						}
						write(message);
						controller.close();
						return;
					}
					if (message.type !== "stream_event") {
						continue;
					}

					switch (message.event.type) {
						case "message_start":
						case "content_block_stop":
						case "message_stop":
							write(message);
							break;
						case "content_block_start":
							if (
								message.event.index !== 0 ||
								message.event.content_block.type !== "text"
							) {
								throw new Error("unsupported Claude content block");
							}
							write(message);
							break;
						case "content_block_delta":
							if (
								message.event.index !== 0 ||
								message.event.delta.type !== "text_delta"
							) {
								throw new Error("unsupported Claude content delta");
							}
							write(message);
							break;
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
			const cwd = `/workspace/conversations/${input.conversationId}`;
			await dependencies.prepareWorkingDirectory(cwd);
			const messages = dependencies.query({
				prompt: input.prompt,
				options: {
					allowedTools: [],
					model: input.model,
					includePartialMessages: true,
					cwd,
					permissionMode: "dontAsk",
					settingSources: [],
					thinking: { type: "disabled" },
					tools: [],
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

export function createAgentQueryServerOptions(
	dependencies: AgentQueryRuntimeDependencies,
	port = 8080,
) {
	return {
		hostname: "0.0.0.0",
		port,
		idleTimeout: 0,
		routes: {
			"/ping": {
				GET: () => Response.json({ status: "Healthy" }),
			},
			"/invocations": {
				POST: createAgentQueryRequestHandler(dependencies),
			},
		},
		fetch: () => jsonError("not found", 404),
	};
}
