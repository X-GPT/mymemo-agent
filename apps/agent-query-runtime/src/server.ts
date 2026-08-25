import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQueryRequest } from "@mymemo/agent-query";
import { z } from "zod";
import type { AgentQuerySessionStore } from "./session-store";

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

const resultBase = z.looseObject({
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
});
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

export type AgentQueryRuntimeDependencies = {
	query(input: {
		prompt: string;
		options: Options;
	}): AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> };
	createSessionStore(input: {
		conversationId: string;
		conversationEpoch: number;
	}): AgentQuerySessionStore;
	prepareWorkingDirectory(path: string): Promise<void>;
	prepareWorkspace(input: {
		conversationId: string;
		conversationEpoch: number;
	}): Promise<AgentQueryWorkspace>;
	verifyResponseAuthority(authority: {
		conversationId: string;
		conversationEpoch: number;
	}): Promise<void>;
};

export type AgentQueryWorkspace = {
	signal: AbortSignal;
	queryOptions: Pick<Options, "allowedTools" | "mcpServers">;
	stop(): Promise<void>;
	dispose(): void;
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

function createNdjsonStream(
	messages: AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> },
	sessionStore: AgentQuerySessionStore,
	workspace: AgentQueryWorkspace,
) {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let interruption: Promise<unknown> | undefined;
			const interrupt = () => {
				interruption ??= messages.interrupt().catch(() => {});
				return interruption;
			};
			workspace.signal.addEventListener("abort", interrupt, { once: true });
			if (workspace.signal.aborted) void interrupt();
			const write = (message: SDKMessage) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
			};
			try {
				for await (const message of messages) {
					if (workspace.signal.aborted) {
						throw workspace.signal.reason instanceof Error
							? workspace.signal.reason
							: new Error("Workspace failed");
					}
					if (message.type === "system") {
						if (message.subtype === "mirror_error") {
							throw new Error("Claude session mirror failed");
						}
						continue;
					}
					if (message.type === "result") {
						const result = resultMessage.safeParse(message);
						if (!result.success) {
							throw new Error("invalid terminal Claude result");
						}
						if (sessionStore.mirroredMainSessionId() !== message.session_id) {
							throw new Error(
								"terminal Claude result has no persisted transcript",
							);
						}
						write(message);
						controller.close();
						workspace.signal.removeEventListener("abort", interrupt);
						workspace.dispose();
						return;
					}
					if (
						message.type === "stream_event" ||
						message.type === "assistant" ||
						isCurrentToolResultMessage(message)
					) {
						write(message);
					}
				}
				throw new Error("Claude stream ended before its terminal result");
			} catch (error) {
				workspace.signal.removeEventListener("abort", interrupt);
				await Promise.allSettled([workspace.stop(), interrupt()]);
				workspace.dispose();
				controller.error(error);
			}
		},
	});
}

function isCurrentToolResultMessage(message: SDKMessage): boolean {
	if (
		message.type !== "user" ||
		("isReplay" in message && message.isReplay === true) ||
		!Array.isArray(message.message.content) ||
		message.message.content.length === 0
	) {
		return false;
	}
	return message.message.content.every(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			block.type === "tool_result",
	);
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
			const binding = {
				conversationId: input.conversationId,
				conversationEpoch: input.conversationEpoch,
			};
			const sessionStore = dependencies.createSessionStore(binding);
			const workspace = await dependencies.prepareWorkspace(binding);
			let messages: ReturnType<AgentQueryRuntimeDependencies["query"]>;
			try {
				messages = dependencies.query({
					prompt: input.prompt,
					options: {
						...workspace.queryOptions,
						model: input.model,
						includePartialMessages: true,
						cwd,
						permissionMode: "dontAsk",
						sessionStore,
						settingSources: [],
						thinking: { type: "disabled" },
						tools: [],
						...(input.agentSessionId ? { resume: input.agentSessionId } : {}),
					},
				});
			} catch (error) {
				await workspace.stop().catch(() => {});
				workspace.dispose();
				throw error;
			}
			return new Response(
				createNdjsonStream(messages, sessionStore, workspace),
				{
					status: 200,
					headers: { "content-type": "application/x-ndjson" },
				},
			);
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
