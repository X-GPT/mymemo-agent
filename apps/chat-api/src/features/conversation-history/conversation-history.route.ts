import { sValidator as zValidator } from "@hono/standard-validator";
import { InvalidRunEventError } from "@mymemo/agent-db/run-events";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import { ConversationIdParam } from "@/features/conversations/conversations.schema";
import { identityFromContext } from "@/features/conversations/internal-identity";
import {
	type ConversationHistoryPage,
	InvalidConversationHistoryCursorError,
} from "./conversation-history-store";

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

const HistoryQuery = z
	.object({
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(MAX_HISTORY_LIMIT)
			.default(DEFAULT_HISTORY_LIMIT),
		cursor: z.string().min(1).max(1024).optional(),
	})
	.strict();

const app = new Hono<AppEnv>();

app.get(
	"/:conversationId/history",
	zValidator(
		"param",
		z.object({ conversationId: ConversationIdParam }),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid conversation id" }, 400);
			}
		},
	),
	zValidator("query", HistoryQuery, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid history query" }, 400);
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
		const { conversationId } = c.req.valid("param");
		const query = c.req.valid("query");
		let page: ConversationHistoryPage | null;
		try {
			page = await c.var.deps.conversationHistoryStore.getPage({
				userId: identity.data.memberCode,
				conversationId,
				limit: query.limit,
				cursor: query.cursor ?? null,
			});
		} catch (error) {
			if (error instanceof InvalidConversationHistoryCursorError) {
				return c.json({ error: "Invalid history cursor" }, 400);
			}
			if (error instanceof InvalidRunEventError) {
				c.var.logger.error({
					message: "Conversation history corruption",
					conversationId,
				});
				return c.json({ error: "Conversation history is unavailable" }, 500);
			}
			throw error;
		}
		if (!page) return c.json({ error: "Conversation not found" }, 404);
		return c.json(page);
	},
);

export default app;
