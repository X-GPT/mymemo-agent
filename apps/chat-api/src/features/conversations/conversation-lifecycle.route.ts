import { sValidator as zValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import {
	createConversation,
	toConversationSummary,
} from "./conversations.controller";
import {
	ConversationIdParam,
	ConversationListQuery,
	CreateConversationBody,
	decodeConversationListCursor,
	encodeConversationListCursor,
	MAX_REQUEST_BODY_BYTES,
	UpdateConversationBody,
} from "./conversations.schema";
import { requireInternalIdentity } from "./internal-identity";

/**
 * Conversation lifecycle routes: list, create, rename/Archive, and permanent
 * deletion. Mounted at both `/v1/conversations` and `/v2/conversations` with
 * identical semantics (#657); the Run routes stay v1-only.
 */
const app = new Hono<AppEnv>();

/** Shared request-body cap for both conversation write endpoints. */
const conversationBodyLimit = bodyLimit({
	maxSize: MAX_REQUEST_BODY_BYTES,
	onError: (c) => c.json({ error: "Request body too large" }, 413),
});
const ConversationPath = z.object({ conversationId: ConversationIdParam });

// GET / — list one owned Archive partition using stable activity keyset
// pagination. Search is evaluated by Postgres before paging.
app.get(
	"/",
	zValidator("query", ConversationListQuery, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid query", issues: result.error }, 400);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const query = c.req.valid("query");
		const after =
			query.cursor === undefined
				? undefined
				: decodeConversationListCursor(query.cursor, query);
		if (query.cursor !== undefined && after === null) {
			return c.json({ error: "Invalid cursor" }, 400);
		}

		const page = await c.var.deps.conversationStore.list({
			userId: c.var.identity.memberCode,
			archived: query.archived,
			search: query.search,
			after: after ?? undefined,
			limit: query.limit,
		});
		return c.json({
			conversations: page.conversations.map(toConversationSummary),
			nextCursor:
				page.next === null
					? null
					: encodeConversationListCursor(query, page.next),
		});
	},
);

// POST / — create a conversation, freezing its document scope.
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
	requireInternalIdentity,
	async (c) => {
		// New-work exposure gate: evaluated on the trusted identity (not the body)
		// before any conversation write. Fails closed.
		if (!(await c.var.deps.exposureGate.isAgentEnabled(c.var.identity))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}
		const result = await createConversation(
			c.var.deps.conversationStore,
			c.var.identity,
			c.req.valid("json"),
		);
		return c.json(result, 201);
	},
);

// PATCH /:conversationId — rename and/or change Archive state.
// Existing-resource control deliberately bypasses the exposure gate.
app.patch(
	"/:conversationId",
	conversationBodyLimit,
	zValidator("param", ConversationPath, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid conversation id" }, 400);
		}
	}),
	zValidator("json", UpdateConversationBody, (result, c) => {
		if (!result.success) {
			return c.json(
				{ error: "Invalid request body", issues: result.error },
				400,
			);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const result = await c.var.deps.conversationStore.update(
			{
				userId: c.var.identity.memberCode,
				conversationId: c.req.valid("param").conversationId,
			},
			c.req.valid("json"),
		);
		if (result.outcome !== "updated") {
			return result.outcome === "not_found"
				? c.json({ error: "Conversation not found" }, 404)
				: c.json({ error: "Conversation has an active Run" }, 409);
		}
		return c.json(toConversationSummary(result.conversation));
	},
);

// DELETE /:conversationId — irreversible user-visible deletion. External
// workspace/session/object cleanup remains asynchronous.
app.delete(
	"/:conversationId",
	zValidator("param", ConversationPath, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid conversation id" }, 400);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const result = await c.var.deps.conversationStore.deletePermanently({
			userId: c.var.identity.memberCode,
			conversationId: c.req.valid("param").conversationId,
		});
		if (result.outcome === "not_found") {
			return c.json({ error: "Conversation not found" }, 404);
		}
		if (result.outcome === "active_run") {
			return c.json({ error: "Conversation has an active Run" }, 409);
		}
		return c.body(null, 204);
	},
);

export default app;
