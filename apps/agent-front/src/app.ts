import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ExposureGate } from "./exposure-gate";
import type { Messages } from "./messages";
import {
	ConversationId,
	CreateBody,
	decodeCursor,
	encodeCursor,
	HistoryQuery,
	InternalIdentity,
	InvalidCursor,
	ListQuery,
	SendBody,
	UpdateBody,
} from "./schema";
import { type ConversationStore, NotFound, Processing } from "./store";

export function createApp(
	store: ConversationStore,
	gate: ExposureGate,
	messages?: Messages,
) {
	const app = new Hono<{
		Variables: { identity: InternalIdentity };
	}>();
	app.onError((error, c) => {
		if (error instanceof NotFound)
			return c.json({ error: "Conversation not found" }, 404);
		if (error instanceof Processing)
			return c.json({ error: "processing", turnId: error.turnId }, 409);
		if (error instanceof InvalidCursor)
			return c.json({ error: "Invalid cursor" }, 400);
		if (error instanceof HTTPException)
			return c.json({ error: error.message }, error.status);
		console.error(
			JSON.stringify({
				conversationId: c.req.param("id") ?? null,
				turnId: null,
				message: "Front request failed",
				name: error.name,
			}),
		);
		return c.json({ error: "internal_error" }, 500);
	});
	app.notFound((c) => c.json({ error: "Not found" }, 404));
	// Identity parsing copied from chat-api, without the retired *-Name headers.
	app.use("/v1/conversations/*", async (c, next) => {
		const identity = InternalIdentity.safeParse({
			memberCode: c.req.header("x-member-code"),
			partnerCode: c.req.header("x-partner-code"),
			teamCode: c.req.header("x-team-code"),
		});
		if (!identity.success)
			return c.json(
				{ error: "Missing or invalid internal identity headers" },
				401,
			);
		c.set("identity", identity.data);
		await next();
	});
	// Ownership and tombstones precede body/query validation on every id route.
	app.use("/v1/conversations/:id/*", async (c, next) => {
		const id = ConversationId.safeParse(c.req.param("id"));
		if (!id.success) throw new NotFound();
		await store.get(id.data, c.var.identity.memberCode);
		await next();
	});
	const cap = bodyLimit({
		maxSize: 10 * 1024 * 1024,
		onError: (c) => c.json({ error: "Request body too large" }, 413),
	});
	app.post(
		"/v1/conversations",
		cap,
		sValidator("json", CreateBody, (r, c) => {
			if (!r.success) return c.json({ error: "Invalid request body" }, 400);
		}),
		async (c) => {
			let enabled = false;
			try {
				enabled = await gate.isAgentEnabled(c.var.identity);
			} catch {
				/* Fail closed, including injected clients. */
			}
			if (!enabled) return c.json({ error: "Agent is not enabled" }, 403);
			return c.json(
				await store.create(c.var.identity, c.req.valid("json")),
				201,
			);
		},
	);
	app.get(
		"/v1/conversations",
		sValidator("query", ListQuery, (r, c) => {
			if (!r.success) return c.json({ error: "Invalid query" }, 400);
		}),
		async (c) => {
			const query = {
				...c.req.valid("query"),
				userId: c.var.identity.memberCode,
			};
			const page = await store.list(query, decodeCursor(query));
			return c.json({
				conversations: page.conversations,
				nextCursor: page.next ? encodeCursor(query, page.next) : null,
			});
		},
	);
	app.patch(
		"/v1/conversations/:id",
		cap,
		sValidator("json", UpdateBody, (r, c) => {
			if (!r.success) return c.json({ error: "Invalid request body" }, 400);
		}),
		async (c) =>
			c.json(
				await store.update(
					c.req.param("id"),
					c.var.identity.memberCode,
					c.req.valid("json"),
				),
			),
	);
	app.delete("/v1/conversations/:id", async (c) => {
		await store.delete(c.req.param("id"), c.var.identity.memberCode);
		return c.body(null, 204);
	});
	app.post(
		"/v1/conversations/:id/messages",
		cap,
		sValidator("json", SendBody, (r, c) => {
			if (!r.success) return c.json({ error: "Invalid request body" }, 400);
		}),
		async (c) => {
			let enabled = false;
			try {
				enabled = await gate.isAgentEnabled(c.var.identity);
			} catch {
				/* Fail closed. */
			}
			if (!enabled) return c.json({ error: "Agent is not enabled" }, 403);
			if (!messages) throw new Error("Messages not configured");
			const { text, requestId, model, maxBudgetUsd } = c.req.valid("json");
			return messages.send(
				c.req.param("id"),
				c.var.identity.memberCode,
				text,
				requestId,
				{ model, maxBudgetUsd },
			);
		},
	);
	app.get(
		"/v1/conversations/:id/messages",
		sValidator("query", HistoryQuery, (r, c) => {
			if (!r.success) return c.json({ error: "Invalid query" }, 400);
		}),
		async (c) => {
			const conversation = await store.get(
				c.req.param("id"),
				c.var.identity.memberCode,
			);
			const { limit, cursor } = c.req.valid("query");
			return c.json(
				messages
					? await messages.history.page(conversation, limit, cursor)
					: { messages: [], nextCursor: null },
			);
		},
	);
	app.get("/v1/conversations/:id/artifacts", async (c) => {
		if (!messages) throw new Error("Messages not configured");
		return c.json({
			artifacts: await messages.artifacts.list(c.req.param("id")),
		});
	});
	app.get(
		"/v1/conversations/:id/artifacts/:artifactId/download-url",
		async (c) => {
			if (!messages) throw new Error("Messages not configured");
			const downloadUrl = await messages.artifacts.downloadUrl(
				c.req.param("id"),
				c.req.param("artifactId"),
			);
			return downloadUrl
				? c.json({ downloadUrl })
				: c.json({ error: "Artifact not found" }, 404);
		},
	);
	return app;
}
