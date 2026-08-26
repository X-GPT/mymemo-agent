import { z } from "zod";

export const AGENTCORE_RUNTIME_SESSION_HEADER =
	"x-amzn-bedrock-agentcore-runtime-session-id";

const conversationIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
const requestSchema = z.strictObject({
	model: z.literal("anthropic/claude-sonnet-5"),
	prompt: z.string().min(1).max(50_000),
});

export type ResponseInvocation = {
	conversationId: string;
	model: "anthropic/claude-sonnet-5";
	prompt: string;
};

export function createResponseInvocationHandler(
	invoke: (request: ResponseInvocation) => ReadableStream<Uint8Array>,
) {
	return async (request: Request): Promise<Response> => {
		if (!request.headers.get("content-type")?.startsWith("application/json")) {
			return Response.json(
				{ error: "content type must be application/json" },
				{ status: 415 },
			);
		}
		const parsed = requestSchema.safeParse(
			await request.json().catch(() => undefined),
		);
		if (!parsed.success) {
			return Response.json(
				{ error: "invalid Agent query request" },
				{ status: 400 },
			);
		}
		const conversationId = conversationIdSchema.safeParse(
			request.headers.get(AGENTCORE_RUNTIME_SESSION_HEADER),
		);
		if (!conversationId.success) {
			return Response.json(
				{ error: "Invalid Runtime session" },
				{ status: 400 },
			);
		}
		try {
			return new Response(
				invoke({
					conversationId: conversationId.data,
					model: parsed.data.model,
					prompt: parsed.data.prompt,
				}),
				{
					headers: {
						"content-type": "application/x-ndjson",
						"cache-control": "no-cache",
					},
				},
			);
		} catch {
			return Response.json(
				{ error: "AgentCore invocation failed" },
				{ status: 503 },
			);
		}
	};
}
