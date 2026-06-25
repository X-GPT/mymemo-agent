import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { validator as zValidator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import { ChatLogger } from "@/features/chat/chat.logger";
import { HonoSSESender } from "@/features/chat/chat.streaming";
import {
	createConversation,
	runConversationTurn,
} from "./conversations.controller";
import {
	ConversationEventBody,
	ConversationIdParam,
	CreateConversationBody,
	InternalIdentity,
	MAX_REQUEST_BODY_BYTES,
} from "./conversations.schema";

const app = new Hono<AppEnv>();

/** Shared request-body cap for both conversation endpoints. */
const conversationBodyLimit = bodyLimit({
	maxSize: MAX_REQUEST_BODY_BYTES,
	onError: (c) => c.json({ error: "Request body too large" }, 413),
});

/** Parse + validate the trusted identity headers off the request. */
function identityFromContext(c: {
	req: { header: (k: string) => string | undefined };
}) {
	return InternalIdentity.safeParse({
		memberCode: c.req.header("x-member-code"),
		memberName: c.req.header("x-member-name"),
		teamCode: c.req.header("x-team-code"),
		partnerCode: c.req.header("x-partner-code"),
		partnerName: c.req.header("x-partner-name"),
	});
}

// POST /v1/conversations — create a conversation, freezing its document scope.
app.post(
	"/",
	conversationBodyLimit,
	zValidator("json", CreateConversationBody, (result, c) => {
		if (!result.success) {
			return c.json(
				{ error: "Invalid request body", issues: result.error },
				400,
			);
		}
	}),
	async (c) => {
		const identity = identityFromContext(c);
		if (!identity.success) {
			return c.json(
				{ error: "Missing or invalid internal identity headers" },
				401,
			);
		}

		const result = await createConversation(
			c.var.deps.conversationStore,
			identity.data,
			c.req.valid("json"),
		);
		return c.json(result, 201);
	},
);

// POST /v1/conversations/:conversationId/events — send an event (today only
// `user.message`) and stream the turn's events back as SSE.
app.post(
	"/:conversationId/events",
	conversationBodyLimit,
	zValidator(
		"param",
		z.object({ conversationId: ConversationIdParam }),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid conversation id" }, 400);
			}
		},
	),
	zValidator("json", ConversationEventBody, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid event body", issues: result.error }, 400);
		}
	}),
	async (c) => {
		const identity = identityFromContext(c);
		if (!identity.success) {
			return c.json(
				{ error: "Missing or invalid internal identity headers" },
				401,
			);
		}
		const store = c.var.deps.conversationStore;

		const { conversationId } = c.req.valid("param");
		const event = c.req.valid("json");

		// Existence + ownership gate before opening the stream: a missing or
		// foreign conversation is a clean 404, not an SSE error frame.
		const conversation = await store.get({
			userId: identity.data.memberCode,
			conversationId,
		});
		if (!conversation) {
			return c.json({ error: "Conversation not found" }, 404);
		}

		return streamSSE(
			c,
			async (stream) => {
				const sender = new HonoSSESender(stream);
				const keepaliveInterval = setInterval(() => {
					sender.sendPing().catch((err) => {
						c.var.logger.error({
							message: "Failed to send keepalive ping",
							error: err,
						});
					});
				}, 5000);

				try {
					await runConversationTurn(
						c.var.deps,
						{ conversation, message: event.text },
						sender,
						new ChatLogger(c.var.logger, identity.data.memberCode),
					);
				} finally {
					clearInterval(keepaliveInterval);
				}
			},
			async (error, stream) => {
				c.var.logger.error({
					message: "Error in conversation event route",
					error,
				});
				const sender = new HonoSSESender(stream);
				await sender.send({
					id: crypto.randomUUID(),
					message: { type: "error", message: error.message },
				});
			},
		);
	},
);

export default app;
