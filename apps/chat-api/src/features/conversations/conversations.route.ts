import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { validator as zValidator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import { projectRun } from "@/features/run-events";
import {
	reportChatLiveTextProjectionSignal,
	reportChatLiveTextSetupSignal,
} from "@/features/run-events/live-text-telemetry";
import { prepareLiveTextSubscription } from "@/features/run-events/prepare-live-text-subscription";
import {
	ActiveRunExistsError,
	ConversationArchivedError,
	ConversationNotFoundError,
	RunInputMismatchError,
} from "@/features/run-store";
import { HonoSSESender } from "@/features/streaming/sse-sender";
import {
	admitAgUiRun,
	createConversation,
	interruptConversationRun,
	queueConversationTurn,
	toConversationSummary,
} from "./conversations.controller";
import {
	ConversationEventBody,
	ConversationIdParam,
	ConversationListQuery,
	CreateConversationBody,
	decodeConversationListCursor,
	encodeConversationListCursor,
	MAX_REQUEST_BODY_BYTES,
	RunAgentInputBody,
	RunIdParam,
	UpdateConversationBody,
} from "./conversations.schema";
import { identityFromContext } from "./internal-identity";

const app = new Hono<AppEnv>();

/** Shared request-body cap for both conversation endpoints. */
const conversationBodyLimit = bodyLimit({
	maxSize: MAX_REQUEST_BODY_BYTES,
	onError: (c) => c.json({ error: "Request body too large" }, 413),
});

const LIVE_STREAM_START_WAIT_MS = 5_000;
const LIVE_STREAM_START_POLL_MS = 25;
const liveStreamDecoder = new TextDecoder("utf-8", { fatal: true });

async function waitForLiveStream(
	c: Context<AppEnv>,
	runId: string,
): Promise<boolean> {
	const deadline = Date.now() + LIVE_STREAM_START_WAIT_MS;
	try {
		for (;;) {
			const status = await c.var.deps.liveStreamReader.status(runId);
			if (status === "streaming" || status === "done") return true;
			if (status === "error" || Date.now() >= deadline) return false;
			await new Promise((resolve) =>
				setTimeout(resolve, LIVE_STREAM_START_POLL_MS),
			);
		}
	} catch {
		return false;
	}
}

async function streamAgUiRun(c: Context<AppEnv>, runId: string, cursor = "") {
	const requestSignal = c.req.raw.signal;
	const iterator = c.var.deps.liveStreamReader
		.read(runId, cursor, requestSignal)
		[Symbol.asyncIterator]();
	let first: Awaited<ReturnType<typeof iterator.next>>;
	try {
		first = await iterator.next();
	} catch (error) {
		c.var.logger.error({
			message: "AG-UI Live Stream initial read failed",
			error,
			runId,
		});
		return c.json({ error: "Live stream temporarily unavailable" }, 503);
	}
	if (first.done) return c.body(null, 204);

	return streamSSE(c, async (stream) => {
		const keepaliveInterval = setInterval(() => {
			stream.write(": ping\n\n").catch(() => {});
		}, 5_000);
		try {
			let next: Awaited<ReturnType<typeof iterator.next>> = first;
			while (!next.done) {
				if (requestSignal.aborted) break;
				await stream.writeSSE({
					id: next.value.cursor,
					data: liveStreamDecoder.decode(next.value.chunk),
				});
				next = await iterator.next();
			}
		} catch (error) {
			c.var.logger.error({
				message: "AG-UI Live Stream read failed",
				error,
				runId,
			});
		} finally {
			clearInterval(keepaliveInterval);
			await iterator.return?.();
		}
	});
}

// GET /v1/conversations — list one owned Archive partition using stable
// activity keyset pagination. Search is evaluated by Postgres before paging.
app.get(
	"/",
	zValidator("query", ConversationListQuery, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid query", issues: result.error }, 400);
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

		const query = c.req.valid("query");
		const after =
			query.cursor === undefined
				? undefined
				: decodeConversationListCursor(query.cursor, query);
		if (query.cursor !== undefined && after === null) {
			return c.json({ error: "Invalid cursor" }, 400);
		}

		const page = await c.var.deps.conversationStore.list({
			userId: identity.data.memberCode,
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

// PATCH /v1/conversations/:conversationId — rename and/or change Archive
// state. Existing-resource control deliberately bypasses the exposure gate.
app.patch(
	"/:conversationId",
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
	zValidator("json", UpdateConversationBody, (result, c) => {
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

		const result = await c.var.deps.conversationStore.update(
			{
				userId: identity.data.memberCode,
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

// DELETE /v1/conversations/:conversationId — irreversible user-visible
// deletion. External workspace/session/object cleanup remains asynchronous.
app.delete(
	"/:conversationId",
	zValidator(
		"param",
		z.object({ conversationId: ConversationIdParam }),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid conversation id" }, 400);
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

		const result = await c.var.deps.conversationStore.deletePermanently({
			userId: identity.data.memberCode,
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

// POST /v1/conversations/:conversationId/runs — atomically admit one strict
// standard AG-UI Run and consume its retained per-Run Redis Stream.
app.post(
	"/:conversationId/runs",
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
	zValidator("json", RunAgentInputBody, (result, c) => {
		if (!result.success) {
			return c.json(
				{ error: "Invalid RunAgentInput", issues: result.error },
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

		const { conversationId } = c.req.valid("param");
		const input = c.req.valid("json");
		if (input.threadId !== conversationId) {
			return c.json({ error: "threadId must match the Conversation id" }, 400);
		}
		const conversation = await c.var.deps.conversationStore.get({
			userId: identity.data.memberCode,
			conversationId,
		});
		if (!conversation) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		const existingRun = await c.var.deps.runStore.getRun({
			userId: identity.data.memberCode,
			conversationId,
			runId: input.runId,
		});
		if (
			existingRun === null &&
			!(await c.var.deps.exposureGate.isAgentEnabled(identity.data))
		) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}

		try {
			const admission = await admitAgUiRun(c.var.deps, {
				conversation,
				input,
			});
			if (admission.outcome === "not_found") {
				return c.json({ error: "Run not found" }, 404);
			}
		} catch (error) {
			if (error instanceof ActiveRunExistsError) {
				return c.json({ error: "Conversation already has an active Run" }, 409);
			}
			if (error instanceof RunInputMismatchError) {
				return c.json({ error: "Run id was reused with different input" }, 409);
			}
			if (error instanceof ConversationArchivedError) {
				return c.json({ error: "Conversation is archived" }, 409);
			}
			if (error instanceof ConversationNotFoundError) {
				return c.json({ error: "Conversation not found" }, 404);
			}
			throw error;
		}

		if (!(await waitForLiveStream(c, input.runId))) {
			return c.json({ error: "Live stream temporarily unavailable" }, 503);
		}
		return streamAgUiRun(c, input.runId);
	},
);

// POST /v1/conversations/:conversationId/events — send an event.
// `user.message` queues a turn and streams its events back as SSE;
// `user.interrupt` cancels an existing owned run and returns JSON.
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

		// `user.interrupt` is a control event for an existing owned run: it must
		// not depend on the new-work exposure gate, never creates a run, and
		// returns JSON without opening SSE. The terminal `canceled` frame is
		// delivered through the original run's stream or the reconnect endpoint.
		// The design doc's pg_notify(runId) worker wake-up for the running case
		// is deferred to the worker milestone — until then the worker observes
		// `cancel_requested` through its heartbeat.
		if (event.type === "user.interrupt") {
			const result = await interruptConversationRun(c.var.deps, {
				conversation,
				runId: event.runId,
			});
			if (result.outcome === "not_found") {
				return c.json({ error: "Run not found" }, 404);
			}
			const body = { runId: result.run.runId, status: result.run.status };
			return c.json(body, result.outcome === "already_terminal" ? 409 : 202);
		}

		// `user.message` is new work and is gated. Evaluated on the trusted
		// identity, after the ownership check but before any run write; fails
		// closed.
		if (!(await c.var.deps.exposureGate.isAgentEnabled(identity.data))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}

		const runId = crypto.randomUUID();
		const liveSubscription = await prepareLiveTextSubscription(
			c.var.deps.liveTextSubscriber,
			runId,
			{
				onSignal: (signal) =>
					reportChatLiveTextSetupSignal(c.var.deps.liveTextTelemetry, signal),
			},
		);
		let queuedRun: { runId: string };
		try {
			queuedRun = await queueConversationTurn(c.var.deps, {
				conversation,
				message: event.text,
				runId,
			});
		} catch (error) {
			await liveSubscription?.close().catch(() => {});
			if (error instanceof ActiveRunExistsError) {
				return c.json(
					{
						error:
							"Conversation is busy processing another request. Please try again shortly.",
					},
					409,
				);
			}
			if (error instanceof ConversationArchivedError) {
				return c.json({ error: "Conversation is archived" }, 409);
			}
			if (error instanceof ConversationNotFoundError) {
				return c.json({ error: "Conversation not found" }, 404);
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
						liveSubscription: liveSubscription ?? undefined,
						signal: requestSignal,
						onLiveTextSignal: (signal) =>
							reportChatLiveTextProjectionSignal(
								c.var.deps.liveTextTelemetry,
								signal,
							),
					})) {
						if (requestSignal.aborted) break;
						await sender.send({
							id: projected.id,
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

		if (!(await waitForLiveStream(c, runId))) {
			return c.json({ error: "Live stream temporarily unavailable" }, 503);
		}
		return streamAgUiRun(c, runId, c.req.header("last-event-id") ?? "");
	},
);

export default app;
