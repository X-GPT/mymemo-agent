import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { validator as zValidator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import { projectRun } from "@/features/run-events";
import { ActiveRunExistsError } from "@/features/run-store";
import { HonoSSESender } from "@/features/streaming/sse-sender";
import {
	createConversation,
	queueConversationTurn,
} from "./conversations.controller";
import {
	ConversationEventBody,
	ConversationIdParam,
	CreateConversationBody,
	InternalIdentity,
	MAX_REQUEST_BODY_BYTES,
	RunIdParam,
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

function lastEventIdFromContext(c: {
	req: { header: (k: string) => string | undefined };
}): number {
	const raw = c.req.header("last-event-id");
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
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

		// New-work exposure gate: evaluated on the trusted identity (not the body)
		// before any conversation write. Fails closed.
		if (!(await c.var.deps.exposureGate.isAgentEnabled(identity.data))) {
			return c.json({ error: "Agent is not enabled" }, 403);
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
		// foreign conversation is a clean 404, not an SSE error frame. This runs
		// before the exposure gate so the 404 ownership contract is preserved — a
		// gated user probing a conversation they don't own still gets 404, not a
		// 403 that would leak the existence of the gate over ownership.
		const conversation = await store.get({
			userId: identity.data.memberCode,
			conversationId,
		});
		if (!conversation) {
			return c.json({ error: "Conversation not found" }, 404);
		}

		// `user.message` is new work and is gated. When `user.interrupt` (a control
		// event for an existing run) is added in a later milestone, it must bypass
		// this gate — branch on `event.type` here at that point. Today the body is
		// only `user.message`, so the gate is unconditional. Evaluated on the
		// trusted identity, after the ownership check but before any run write;
		// fails closed.
		if (!(await c.var.deps.exposureGate.isAgentEnabled(identity.data))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}

		let queuedRun: { runId: string };
		try {
			queuedRun = await queueConversationTurn(c.var.deps, {
				conversation,
				message: event.text,
			});
		} catch (error) {
			if (error instanceof ActiveRunExistsError) {
				return c.json(
					{
						error:
							"Conversation is busy processing another request. Please try again shortly.",
					},
					409,
				);
			}
			throw error;
		}

		const requestSignal = c.req.raw.signal;
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
					for await (const projected of projectRun(queuedRun.runId, 0, {
						reader: c.var.deps.runEventReader,
						notifier: c.var.deps.runNotifier,
					})) {
						if (requestSignal.aborted) break;
						await sender.send({
							id: String(projected.seq),
							message: projected.frame,
						});
					}
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

// GET /v1/conversations/:conversationId/runs/:runId/events — reconnect to an
// existing owned run without creating another backend attempt.
app.get(
	"/:conversationId/runs/:runId/events",
	zValidator(
		"param",
		z.object({
			conversationId: ConversationIdParam,
			runId: RunIdParam,
		}),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid conversation or run id" }, 400);
			}
		},
	),
	async (c) => {
		const identity = identityFromContext(c);
		if (!identity.success) {
			return c.json(
				{ error: "Missing or invalid internal identity headers" },
				401,
			);
		}

		const { conversationId, runId } = c.req.valid("param");
		const conversation = await c.var.deps.conversationStore.get({
			userId: identity.data.memberCode,
			conversationId,
		});
		if (!conversation) {
			return c.json({ error: "Conversation not found" }, 404);
		}

		const run = await c.var.deps.runStore.getRun({
			userId: identity.data.memberCode,
			conversationId,
			runId,
		});
		if (!run) {
			return c.json({ error: "Run not found" }, 404);
		}

		const afterSeq = lastEventIdFromContext(c);
		const requestSignal = c.req.raw.signal;
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
					for await (const projected of projectRun(runId, afterSeq, {
						reader: c.var.deps.runEventReader,
						notifier: c.var.deps.runNotifier,
					})) {
						if (requestSignal.aborted) break;
						await sender.send({
							id: String(projected.seq),
							message: projected.frame,
						});
					}
				} finally {
					clearInterval(keepaliveInterval);
				}
			},
			async (error, stream) => {
				c.var.logger.error({
					message: "Error in conversation run replay route",
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
