import { sValidator as zValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import {
	ConversationIdParam,
	MAX_REQUEST_BODY_BYTES,
	RunIdParam,
} from "@/features/conversations/conversations.schema";
import { requireInternalIdentity } from "@/features/conversations/internal-identity";

const chatBody = z.strictObject({
	id: ConversationIdParam,
	messages: z.tuple([
		z.strictObject({
			id: RunIdParam,
			role: z.literal("user"),
			parts: z.tuple([
				z.strictObject({
					type: z.literal("text"),
					text: z.string().min(1).max(50_000),
				}),
			]),
		}),
	]),
	model: z.literal("anthropic/claude-sonnet-5"),
	trigger: z.literal("submit-message"),
});

/**
 * Forward `response` unchanged and run `cleanup` once its body has been fully
 * read, cancelled, or failed — the Harness sandbox must not outlive the turn.
 * Hand-rolled because Bun 1.3 honours neither `TransformStream.cancel` nor
 * `finally` in an async-generator body when the client cancels.
 */
function cleanupAfterStream(
	response: Response,
	cleanup: () => Promise<void>,
): Response {
	if (!response.body) return response;
	const reader = response.body.getReader();
	let finished = false;
	const finish = async () => {
		if (finished) return;
		finished = true;
		await cleanup();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (error) {
				controller.error(error);
				await finish();
				return;
			}
			if (chunk.done) {
				controller.close();
				await finish();
			} else {
				controller.enqueue(chunk.value);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			await finish();
		},
	});
	return new Response(body, response);
}

const routes = new Hono<AppEnv>();
const limit = bodyLimit({
	maxSize: MAX_REQUEST_BODY_BYTES,
	onError: (c) => c.json({ error: "Request body too large" }, 413),
});

routes.post(
	"/",
	limit,
	zValidator("json", chatBody, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid AI SDK chat input" }, 400);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const body = c.req.valid("json");
		const message = body.messages[0];
		const conversation = await c.var.deps.conversationStore.get({
			userId: c.var.identity.memberCode,
			conversationId: body.id,
		});
		if (!conversation) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		if (conversation.archivedAt !== null) {
			return c.json({ error: "Conversation is archived" }, 409);
		}
		if (!(await c.var.deps.exposureGate.isAgentEnabled(c.var.identity))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}
		const agent = c.var.deps.harnessChatAgent;
		const session = await agent.createSession({ sessionId: body.id });
		const destroy = () =>
			session.destroy().catch((error: unknown) => {
				c.var.logger.warn(
					{ err: error, conversationId: body.id },
					"harness session destroy failed",
				);
			});
		let result: Awaited<ReturnType<typeof agent.stream>>;
		try {
			result = await agent.stream({
				session,
				prompt: message.parts[0].text,
				abortSignal: c.req.raw.signal,
			});
		} catch (error) {
			c.var.logger.error(
				{ err: error, conversationId: body.id },
				"harness turn failed to start",
			);
			await destroy();
			throw error;
		}
		return cleanupAfterStream(
			result.toUIMessageStreamResponse({
				// Details stay in the log; the client only ever sees the generic text.
				onError: (error) => {
					c.var.logger.error(
						{ err: error, conversationId: body.id },
						"harness turn failed while streaming",
					);
					return "An error occurred.";
				},
			}),
			destroy,
		);
	},
);

export default routes;
