import { sValidator as zValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import { ConversationIdParam } from "@/features/conversations/conversations.schema";
import { requireInternalIdentity } from "@/features/conversations/internal-identity";

const DEFAULT_MESSAGES_LIMIT = 50;
const MAX_MESSAGES_LIMIT = 100;

// An over-large limit clamps to the cap instead of erroring (the #663 read
// contract); everything non-numeric, negative, zero, or fractional is a 400.
const MessagesLimit = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().min(1))
	.transform((limit) => Math.min(limit, MAX_MESSAGES_LIMIT));

// The cursor is a raw `sequence` value handed back as `nextCursor`.
const BeforeSequence = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int());

const MessagesQuery = z
	.object({
		limit: MessagesLimit.default(DEFAULT_MESSAGES_LIMIT),
		before: BeforeSequence.optional(),
	})
	.strict();

/**
 * `GET /:conversationId/messages` (mounted at `/v2/conversations`) — the
 * durable UIMessage history (spec #654, ticket #663). Owner-scoped via
 * internal identity; reads bypass the new-work exposure gate (v1 precedent).
 */
const app = new Hono<AppEnv>();

app.get(
	"/:conversationId/messages",
	zValidator(
		"param",
		z.object({ conversationId: ConversationIdParam }),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid conversation id" }, 400);
			}
		},
	),
	zValidator("query", MessagesQuery, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid messages query" }, 400);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const query = c.req.valid("query");
		const page = await c.var.deps.conversationMessagesStore.getPage({
			userId: c.var.identity.memberCode,
			conversationId: c.req.valid("param").conversationId,
			limit: query.limit,
			before: query.before ?? null,
		});
		if (!page) return c.json({ error: "Conversation not found" }, 404);
		return c.json(page);
	},
);

export default app;
