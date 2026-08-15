import { InvalidCanaryDispatchEnvelopeError } from "agentcore-canary-dispatch/contract";
import {
	RuntimeBusyError,
	RuntimeSessionMismatchError,
	RuntimeShuttingDownError,
} from "./runtime";

export const AGENTCORE_RUNTIME_SESSION_HEADER =
	"x-amzn-bedrock-agentcore-runtime-session-id";
const MAX_INVOCATION_BYTES = 64 * 1024;

class RuntimeInvocationBodyTooLargeError extends Error {
	override readonly name = "RuntimeInvocationBodyTooLargeError";
}

interface RuntimeRequestBoundary {
	health(): { status: "Healthy" | "HealthyBusy" };
	invoke(input: {
		rawEnvelope: string;
		runtimeSessionId: string;
	}): Promise<{ body: ReadableStream<Uint8Array> }>;
}

async function readBoundedBody(request: Request): Promise<string> {
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > MAX_INVOCATION_BYTES) {
		throw new RuntimeInvocationBodyTooLargeError(
			"AgentCore invocation body is too large",
		);
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
				throw new RuntimeInvocationBodyTooLargeError(
					"AgentCore invocation body is too large",
				);
			}
			body += decoder.decode(part.value, { stream: true });
		}
		body += decoder.decode();
		return body;
	} finally {
		reader.releaseLock();
	}
}

function jsonError(
	message: string,
	status: number,
	headers?: Record<string, string>,
): Response {
	return Response.json({ error: message }, { status, headers });
}

function isInvalidRequest(error: unknown): boolean {
	return (
		error instanceof RuntimeSessionMismatchError ||
		error instanceof InvalidCanaryDispatchEnvelopeError ||
		error instanceof RuntimeInvocationBodyTooLargeError
	);
}

/** AgentCore's request-oriented HTTP contract. Request cancellation is not
 * forwarded to the detached Runtime execution. */
export function createRuntimeRequestHandler(runtime: RuntimeRequestBoundary) {
	return async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		if (pathname === "/ping") {
			if (request.method !== "GET") return jsonError("method not allowed", 405);
			return Response.json(runtime.health());
		}
		if (pathname !== "/invocations") {
			return jsonError("not found", 404);
		}
		if (request.method !== "POST") {
			return jsonError("method not allowed", 405);
		}
		if (!request.headers.get("content-type")?.startsWith("application/json")) {
			return jsonError("content type must be application/json", 415);
		}
		const runtimeSessionId = request.headers.get(
			AGENTCORE_RUNTIME_SESSION_HEADER,
		);
		if (!runtimeSessionId) {
			return jsonError("Runtime session identity is required", 400);
		}

		try {
			const invocation = await runtime.invoke({
				rawEnvelope: await readBoundedBody(request),
				runtimeSessionId,
			});
			return new Response(invocation.body, {
				status: 200,
				headers: { "content-type": "application/x-ndjson" },
			});
		} catch (error) {
			if (
				error instanceof RuntimeBusyError ||
				error instanceof RuntimeShuttingDownError
			) {
				return jsonError(error.message, 503, { "retry-after": "1" });
			}
			if (isInvalidRequest(error)) {
				return jsonError((error as Error).message, 400);
			}
			return jsonError("AgentCore invocation failed", 503);
		}
	};
}

export function startRuntimeServer(
	runtime: RuntimeRequestBoundary,
	port = 8080,
) {
	return Bun.serve({
		hostname: "0.0.0.0",
		port,
		fetch: createRuntimeRequestHandler(runtime),
	});
}
