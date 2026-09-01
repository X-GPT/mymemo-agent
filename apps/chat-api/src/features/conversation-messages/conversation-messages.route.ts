import { setTimeout as delay } from "node:timers/promises";
import { sValidator as zValidator } from "@hono/standard-validator";
import { TERMINAL_TURN_STATUSES } from "@mymemo/agent-db/schema";
import type { TurnStatus } from "@mymemo/agent-db/turn-store";
import { classifyLiveStreamFailure } from "@mymemo/live-text";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import {
	ConversationIdParam,
	ConversationPath,
	conversationBodyLimit,
	MAX_MESSAGE_LENGTH,
} from "@/features/conversations/conversations.schema";
import { requireInternalIdentity } from "@/features/conversations/internal-identity";

const DEFAULT_MESSAGES_LIMIT = 50;
const MAX_MESSAGES_LIMIT = 100;
const LIVE_STREAM_KEEPALIVE_MS = 5_000;

const UserTextPart = z
	.object({
		type: z.literal("text"),
		text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
	})
	.strict();

// The submitted UIMessage. Its client id becomes the Turn id, which names the
// Turn's Live Stream channel, so it is held to the same path-safe shape as a
// Conversation id.
const UserUiMessage = z
	.object({
		id: ConversationIdParam,
		role: z.literal("user"),
		parts: z.array(UserTextPart).min(1),
	})
	.strict();

// The stock `useChat`/`DefaultChatTransport` request body. Only the final
// message is submitted; the earlier ones are the client's own history and
// validation input, never new durable history (the v1 stance).
const SubmitMessageBody = z
	.object({
		id: ConversationIdParam,
		trigger: z.literal("submit-message"),
		messages: z.array(z.unknown()).min(1),
	})
	.strict();

function isTerminalTurnStatus(status: TurnStatus): boolean {
	return (TERMINAL_TURN_STATUSES as readonly TurnStatus[]).includes(status);
}

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

/**
 * `POST /:conversationId/messages` (mounted at `/v2/conversations`) — submit a
 * UIMessage (spec #654, ticket #667). Persist it `queued`, subscribe to the
 * Turn's Live Stream BEFORE nudging the In-VM server, then relay the stock AI
 * SDK v7 UI Message Stream scoped to this Turn: silent keepalives while queued
 * predecessors drain, then only this Turn's chunks, ending at its terminal
 * chunk. There is no 409 for concurrency — a second POST is the next queued
 * row — and chat-api never interrupts anything: a client disconnect leaves the
 * Turn running to its Outcome.
 */
app.post(
	"/:conversationId/messages",
	conversationBodyLimit,
	zValidator("param", ConversationPath, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid conversation id" }, 400);
		}
	}),
	zValidator("json", SubmitMessageBody, (result, c) => {
		if (!result.success) {
			return c.json(
				{ error: "Invalid message submission", issues: result.error },
				400,
			);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const { conversationId } = c.req.valid("param");
		const body = c.req.valid("json");
		if (body.id !== conversationId) {
			return c.json({ error: "id must match the Conversation id" }, 400);
		}
		const message = UserUiMessage.safeParse(body.messages.at(-1));
		if (!message.success) {
			return c.json(
				{ error: "Final message must be one user UIMessage with text parts" },
				400,
			);
		}
		const { deps, logger } = c.var;
		const nudge = deps.nudgeInVmServer;
		if (!nudge) return c.json({ error: "v2 messaging is not configured" }, 503);
		if (!(await deps.exposureGate.isAgentEnabled(c.var.identity))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}

		const ref = {
			userId: c.var.identity.memberCode,
			conversationId,
			messageId: message.data.id,
		};
		const admitted = await deps.conversationMessagesStore.enqueueTurn({
			...ref,
			parts: message.data.parts,
		});
		if (admitted.outcome === "not_found") {
			return c.json({ error: "Conversation not found" }, 404);
		}
		if (admitted.outcome === "archived") {
			return c.json({ error: "Conversation is archived" }, 409);
		}
		if (admitted.outcome === "not_a_turn") {
			return c.json({ error: "Message id names an assistant message" }, 409);
		}
		if (
			admitted.outcome === "duplicate" &&
			isTerminalTurnStatus(admitted.status)
		) {
			// The Live Stream died with the Turn; durable history has it.
			return c.json({ error: "Turn already ended", recovery: "history" }, 410);
		}

		// Subscribe before nudging: the lane keeps no backlog, so this ordering
		// is what makes early chunks unlosable.
		const readAbort = new AbortController();
		const readSignal = AbortSignal.any([c.req.raw.signal, readAbort.signal]);
		let chunks: AsyncIterable<string>;
		try {
			chunks = await deps.turnLiveStreamRelay.subscribe(ref, readSignal);
		} catch (error) {
			logger.error(
				{ ...ref, reason: classifyLiveStreamFailure(error) },
				"v2 Live Stream subscribe failed",
			);
			// The Turn is durably queued; let it run so history has it.
			await nudge().catch(() => {});
			return c.json({ error: "Live stream temporarily unavailable" }, 503);
		}
		try {
			await nudge();
		} catch (error) {
			// The row is durable and the In-VM server's interval self-heal
			// consults Postgres on its own; stream on rather than fail the Turn.
			logger.warn(
				{ ...ref, err: error },
				"nudge failed; the queued Turn waits for the In-VM server",
			);
		}

		for (const [name, value] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) {
			c.header(name, value);
		}
		return streamSSE(c, async (stream) => {
			stream.onAbort(() => readAbort.abort());
			const gone = () => stream.aborted || c.req.raw.signal.aborted;
			// One tick does both: the SSE comment keepalive, and the terminal
			// watch that ends a stream whose publisher died without a terminal
			// chunk (the In-VM server restarts, sweeping the Turn `interrupted`).
			// Ticks chain rather than overlap, and the abortable delay ends the
			// loop the moment the read signal fires. The In-VM server commits the
			// Outcome BEFORE publishing the terminal chunk, so one terminal read
			// may be that window; two consecutive reads mean the chunk is not
			// coming.
			void (async () => {
				let terminalReads = 0;
				for (;;) {
					try {
						await delay(LIVE_STREAM_KEEPALIVE_MS, undefined, {
							signal: readSignal,
						});
						await stream.write(": ping\n\n");
					} catch {
						if (!readSignal.aborted) stream.abort();
						return;
					}
					try {
						const status =
							await deps.conversationMessagesStore.getTurnStatus(ref);
						terminalReads =
							status === null || isTerminalTurnStatus(status)
								? terminalReads + 1
								: 0;
						if (terminalReads >= 2) {
							readAbort.abort();
							return;
						}
					} catch (error) {
						// A failed read is retried next tick; the Live Stream itself is
						// unaffected, so the response stays open.
						logger.warn(
							{ ...ref, err: error },
							"v2 terminal watch read failed",
						);
					}
				}
			})();
			try {
				for await (const chunk of chunks) {
					await stream.write(`data: ${chunk}\n\n`);
				}
				// A clean end: the terminal chunk arrived, or the terminal watch
				// found the Turn ended. A disconnected client gets nothing more.
				if (!gone()) await stream.write("data: [DONE]\n\n");
			} catch (error) {
				if (!gone()) {
					// Close the incomplete stream without synthesizing a chunk; the
					// client Recovers from durable history.
					logger.error(
						{ ...ref, reason: classifyLiveStreamFailure(error) },
						"v2 Live Stream read failed",
					);
				}
			} finally {
				readAbort.abort();
			}
		});
	},
);

export default app;
