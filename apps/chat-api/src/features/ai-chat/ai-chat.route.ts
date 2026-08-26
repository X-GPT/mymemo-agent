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
import { toAiSdkResponse } from "./response-stream";

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
		if (!(await c.var.deps.exposureGate.isAgentEnabled(c.var.identity))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}
		const body = c.req.valid("json");
		const message = body.messages[0];
		const admission = await c.var.deps.admitUserMessage({
			userId: c.var.identity.memberCode,
			conversationId: body.id,
			messageId: message.id,
			parts: message.parts,
		});
		if (admission.outcome === "not_found") {
			return c.json({ error: "Conversation not found" }, 404);
		}
		if (admission.outcome === "archived") {
			return c.json({ error: "Conversation is archived" }, 409);
		}
		if (admission.outcome === "conflict") {
			return c.json({ error: "Message id conflict" }, 409);
		}
		const upstream = await c.var.deps.agentQueryRuntimeInvoker({
			conversationId: body.id,
			model: body.model,
			prompt: message.parts[0].text,
		});
		return toAiSdkResponse(upstream, ({ messageId, parts }) =>
			c.var.deps.appendAssistantMessage({
				userId: c.var.identity.memberCode,
				conversationId: body.id,
				messageId,
				parts,
			}),
		);
	},
);

export default routes;
