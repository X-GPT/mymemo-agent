import { LiveStreamStoreError, parseLiveStreamCursor } from "@mymemo/live-text";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
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
	type RunRecord,
} from "@/features/run-store";
import { HonoSSESender } from "@/features/streaming/sse-sender";
import {
	admitAgUiRun,
	createConversation,
	interruptConversationRun,
	queueConversationTurn,
} from "./conversations.controller";
import {
	ConversationEventBody,
	ConversationIdParam,
	CreateConversationBody,
	MAX_REQUEST_BODY_BYTES,
	RunAgentInputBody,
	RunIdParam,
} from "./conversations.schema";
import { identityFromContext } from "./internal-identity";

const app = new Hono<AppEnv>();

/** Shared request-body cap for both conversation endpoints. */
const conversationBodyLimit = bodyLimit({
	maxSize: MAX_REQUEST_BODY_BYTES,
	onError: (c) => c.json({ error: "Request body too large" }, 413),
});

const LIVE_STREAM_START_POLL_MS = 100;
const LIVE_STREAM_KEEPALIVE_MS = 5_000;
const liveStreamDecoder = new TextDecoder("utf-8", { fatal: true });

function isTerminalRunStatus(status: RunRecord["status"]): boolean {
	return status === "done" || status === "error" || status === "canceled";
}

function liveStreamRecoveryResponse(c: Context<AppEnv>) {
	return c.json({ error: "Live stream unavailable", recovery: "history" }, 410);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

type LiveStreamEntry = { cursor: string; chunk: Uint8Array };

function linkedAbortController(parent: AbortSignal): {
	controller: AbortController;
	dispose: () => void;
} {
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(parent.reason);
	if (parent.aborted) forwardAbort();
	else parent.addEventListener("abort", forwardAbort, { once: true });
	return {
		controller,
		dispose: () => parent.removeEventListener("abort", forwardAbort),
	};
}

function endAgUiStreamOnKeepaliveFailure(
	c: Context<AppEnv>,
	runId: string,
	stream: SSEStreamingApi,
	readController: AbortController,
	error: unknown,
): void {
	c.var.logger.error({
		message: "AG-UI keepalive write failed",
		error,
		runId,
	});
	readController.abort(error);
	stream.abort();
}

function startAgUiKeepalive(
	writePing: () => Promise<unknown>,
	onFailure: (error: unknown) => void,
): () => void {
	let interval: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		if (interval !== undefined) clearInterval(interval);
		interval = undefined;
	};
	interval = setInterval(() => {
		writePing().catch((error) => {
			stop();
			onFailure(error);
		});
	}, LIVE_STREAM_KEEPALIVE_MS);
	return stop;
}

async function writeAgUiEntries(
	c: Context<AppEnv>,
	runId: string,
	iterator: AsyncIterator<LiveStreamEntry>,
	first: IteratorResult<LiveStreamEntry>,
	writeSSE: (event: { id: string; data: string }) => Promise<unknown>,
): Promise<void> {
	let next = first;
	try {
		while (!next.done) {
			if (c.req.raw.signal.aborted) break;
			await writeSSE({
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
		await iterator.return?.();
	}
}

async function streamAgUiRun(
	c: Context<AppEnv>,
	run: RunRecord,
	cursor: string,
	status: "streaming" | "done",
) {
	const requestSignal = c.req.raw.signal;
	const readAbort = linkedAbortController(requestSignal);
	const iterator = c.var.deps.liveStreamReader
		.read(run.runId, cursor, readAbort.controller.signal)
		[Symbol.asyncIterator]();
	const firstRead = iterator.next().then(
		(result) => ({ outcome: "read" as const, result }),
		(error: unknown) => ({ outcome: "error" as const, error }),
	);
	let first: Awaited<ReturnType<typeof iterator.next>>;
	const initial =
		status === "streaming"
			? await Promise.race([
					firstRead,
					abortableDelay(LIVE_STREAM_KEEPALIVE_MS, requestSignal).then(() => ({
						outcome: "ping" as const,
					})),
				])
			: await firstRead;
	if (initial.outcome === "error") {
		const { error } = initial;
		readAbort.dispose();
		await iterator.return?.();
		if (
			error instanceof LiveStreamStoreError &&
			error.code === "invalid_cursor"
		) {
			return c.json({ error: "Invalid Last-Event-ID" }, 400);
		}
		c.var.logger.error({
			message: "AG-UI Live Stream initial read failed",
			error,
			runId: run.runId,
		});
		return isTerminalRunStatus(run.status)
			? liveStreamRecoveryResponse(c)
			: c.json({ error: "Live stream temporarily unavailable" }, 503);
	}
	if (initial.outcome === "ping") {
		if (requestSignal.aborted) {
			readAbort.controller.abort(requestSignal.reason);
			readAbort.dispose();
			await iterator.return?.();
			return c.body(null, 204);
		}
		return streamSSE(c, async (stream) => {
			stream.onAbort(() => readAbort.controller.abort());
			let stopKeepalive = () => {};
			try {
				await stream.write(": ping\n\n");
				stopKeepalive = startAgUiKeepalive(
					() => stream.write(": ping\n\n"),
					(error) =>
						endAgUiStreamOnKeepaliveFailure(
							c,
							run.runId,
							stream,
							readAbort.controller,
							error,
						),
				);
				const delayed = await firstRead;
				if (delayed.outcome === "error") {
					c.var.logger.error({
						message: "AG-UI Live Stream read failed",
						error: delayed.error,
						runId: run.runId,
					});
					await iterator.return?.();
					return;
				}
				if (delayed.result.done) {
					await iterator.return?.();
					return;
				}
				await writeAgUiEntries(
					c,
					run.runId,
					iterator,
					delayed.result,
					(event) => stream.writeSSE(event),
				);
			} finally {
				stopKeepalive();
				readAbort.controller.abort();
				readAbort.dispose();
				await iterator.return?.();
			}
		});
	}
	first = initial.result;
	if (first.done) {
		readAbort.dispose();
		await iterator.return?.();
		if (status === "done" && cursor !== "") return c.body(null, 204);
		return isTerminalRunStatus(run.status)
			? liveStreamRecoveryResponse(c)
			: c.json({ error: "Live stream temporarily unavailable" }, 503);
	}

	return streamSSE(c, async (stream) => {
		stream.onAbort(() => readAbort.controller.abort());
		const stopKeepalive = startAgUiKeepalive(
			() => stream.write(": ping\n\n"),
			(error) =>
				endAgUiStreamOnKeepaliveFailure(
					c,
					run.runId,
					stream,
					readAbort.controller,
					error,
				),
		);
		try {
			await writeAgUiEntries(c, run.runId, iterator, first, (event) =>
				stream.writeSSE(event),
			);
		} finally {
			stopKeepalive();
			readAbort.controller.abort();
			readAbort.dispose();
		}
	});
}

function waitForAndStreamAgUiRun(c: Context<AppEnv>, run: RunRecord) {
	const requestSignal = c.req.raw.signal;
	return streamSSE(c, async (stream) => {
		const readAbort = linkedAbortController(requestSignal);
		const readSignal = readAbort.controller.signal;
		stream.onAbort(() => readAbort.controller.abort());
		const stopKeepalive = startAgUiKeepalive(
			() => stream.write(": ping\n\n"),
			(error) =>
				endAgUiStreamOnKeepaliveFailure(
					c,
					run.runId,
					stream,
					readAbort.controller,
					error,
				),
		);
		try {
			for (;;) {
				if (readSignal.aborted) return;
				const currentRun = await c.var.deps.runStore.getRun({
					userId: run.userId,
					conversationId: run.conversationId,
					runId: run.runId,
				});
				if (currentRun === null || currentRun.liveStreamFailedAt !== null) {
					return;
				}

				let status: Awaited<
					ReturnType<typeof c.var.deps.liveStreamReader.status>
				>;
				try {
					status = await c.var.deps.liveStreamReader.status(run.runId);
				} catch {
					return;
				}
				if (status === "error") return;
				if (status === "streaming" || status === "done") break;
				if (isTerminalRunStatus(currentRun.status)) return;
				await abortableDelay(LIVE_STREAM_START_POLL_MS, readSignal);
			}

			const iterator = c.var.deps.liveStreamReader
				.read(run.runId, "", readSignal)
				[Symbol.asyncIterator]();
			let first: Awaited<ReturnType<typeof iterator.next>>;
			try {
				first = await iterator.next();
			} catch (error) {
				c.var.logger.error({
					message: "AG-UI Live Stream read failed after waiting for creation",
					error,
					runId: run.runId,
				});
				await iterator.return?.();
				return;
			}
			if (first.done) {
				await iterator.return?.();
				return;
			}
			await writeAgUiEntries(c, run.runId, iterator, first, (event) =>
				stream.writeSSE(event),
			);
		} finally {
			stopKeepalive();
			readAbort.controller.abort();
			readAbort.dispose();
		}
	});
}

async function respondWithAgUiRun(
	c: Context<AppEnv>,
	run: RunRecord,
	cursor: string,
) {
	if (run.liveStreamFailedAt !== null) return liveStreamRecoveryResponse(c);

	let status: Awaited<ReturnType<typeof c.var.deps.liveStreamReader.status>>;
	try {
		status = await c.var.deps.liveStreamReader.status(run.runId);
	} catch {
		return isTerminalRunStatus(run.status)
			? liveStreamRecoveryResponse(c)
			: c.json({ error: "Live stream temporarily unavailable" }, 503);
	}
	if (status === "error") return liveStreamRecoveryResponse(c);
	if (status === "missing") {
		if (isTerminalRunStatus(run.status)) return liveStreamRecoveryResponse(c);
		if (cursor !== "") {
			return c.json({ error: "Invalid Last-Event-ID" }, 400);
		}
		return waitForAndStreamAgUiRun(c, run);
	}
	return streamAgUiRun(c, run, cursor, status);
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

		let admittedRun: RunRecord;
		try {
			const admission = await admitAgUiRun(c.var.deps, {
				conversation,
				input,
			});
			if (admission.outcome === "not_found") {
				return c.json({ error: "Run not found" }, 404);
			}
			admittedRun = admission.run;
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

		return respondWithAgUiRun(c, admittedRun, "");
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
		let cursor: string;
		try {
			cursor = parseLiveStreamCursor(c.req.header("last-event-id"));
		} catch {
			return c.json({ error: "Invalid Last-Event-ID" }, 400);
		}
		return respondWithAgUiRun(c, run, cursor);
	},
);

export default app;
