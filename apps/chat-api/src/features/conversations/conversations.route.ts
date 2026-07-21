import {
	classifyLiveStreamFailure,
	type LiveStreamReason,
	LiveStreamStoreError,
	parseLiveStreamCursor,
} from "@mymemo/live-text";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { validator as zValidator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import {
	ActiveRunExistsError,
	ConversationArchivedError,
	ConversationNotFoundError,
	RunInputMismatchError,
	type RunRecord,
} from "@/features/run-store";
import {
	admitAgUiRun,
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

const LIVE_STREAM_START_POLL_MS = 100;
const LIVE_STREAM_KEEPALIVE_MS = 5_000;
const liveStreamDecoder = new TextDecoder("utf-8", { fatal: true });

function isTerminalRunStatus(status: RunRecord["status"]): boolean {
	return status === "done" || status === "error" || status === "canceled";
}

function liveStreamRecoveryResponse(c: Context<AppEnv>) {
	c.var.deps.liveStreamTelemetry.record("recovery_response", "history_410");
	return c.json({ error: "Live stream unavailable", recovery: "history" }, 410);
}

async function liveStreamReadFailureResponse(
	c: Context<AppEnv>,
	run: RunRecord,
	reason: LiveStreamReason,
) {
	const currentRun = await c.var.deps.runStore.getRun({
		userId: run.userId,
		conversationId: run.conversationId,
		runId: run.runId,
	});
	if (currentRun === null) return c.json({ error: "Run not found" }, 404);
	if (
		currentRun.liveStreamFailedAt !== null ||
		isTerminalRunStatus(currentRun.status)
	) {
		return liveStreamRecoveryResponse(c);
	}
	c.var.deps.liveStreamTelemetry.record("reconnect_response", "retryable_503", {
		reason,
	});
	return c.json({ error: "Live stream temporarily unavailable" }, 503);
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
		runId,
		reason: "sse_write_failed",
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
			runId,
			reason: classifyLiveStreamFailure(error),
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
			runId: run.runId,
			reason: classifyLiveStreamFailure(error),
		});
		return liveStreamReadFailureResponse(
			c,
			run,
			classifyLiveStreamFailure(error),
		);
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
						runId: run.runId,
						reason: classifyLiveStreamFailure(delayed.error),
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
		return liveStreamReadFailureResponse(c, run, "missing");
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
	const waitStartedAt = Date.now();
	let waitRecorded = false;
	const recordWait = (
		result: "aborted" | "failure" | "success",
		reason?: LiveStreamReason,
	) => {
		if (waitRecorded) return;
		waitRecorded = true;
		c.var.deps.liveStreamTelemetry.record("read_wait", result, {
			...(reason ? { reason } : {}),
			durationMs: Date.now() - waitStartedAt,
		});
	};
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
				if (readSignal.aborted) {
					recordWait("aborted");
					return;
				}
				const currentRun = await c.var.deps.runStore.getRun({
					userId: run.userId,
					conversationId: run.conversationId,
					runId: run.runId,
				});
				if (currentRun === null || currentRun.liveStreamFailedAt !== null) {
					recordWait("failure", "missing");
					return;
				}

				let status: Awaited<
					ReturnType<typeof c.var.deps.liveStreamReader.status>
				>;
				try {
					status = await c.var.deps.liveStreamReader.status(run.runId);
				} catch (error) {
					recordWait("failure", classifyLiveStreamFailure(error));
					return;
				}
				if (status === "error") {
					recordWait("failure", "missing");
					return;
				}
				if (status === "streaming" || status === "done") {
					recordWait("success");
					break;
				}
				if (isTerminalRunStatus(currentRun.status)) {
					recordWait("failure", "missing");
					return;
				}
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
					runId: run.runId,
					reason: classifyLiveStreamFailure(error),
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
			if (!waitRecorded) recordWait("aborted");
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
	} catch (error) {
		return liveStreamReadFailureResponse(
			c,
			run,
			classifyLiveStreamFailure(error),
		);
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

// POST /v1/conversations/:conversationId/runs/:runId/cancel — durably cancel
// an owned Run without admitting new work or opening an SSE response.
app.post(
	"/:conversationId/runs/:runId/cancel",
	zValidator(
		"param",
		z.object({
			conversationId: ConversationIdParam,
			runId: RunIdParam,
		}),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid conversation or Run id" }, 400);
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
		const result = await c.var.deps.runStore.requestCancellation({
			userId: identity.data.memberCode,
			conversationId,
			runId,
		});
		if (result.outcome === "not_found") {
			return c.json({ error: "Run not found" }, 404);
		}
		const body = { runId: result.run.runId, status: result.run.status };
		return c.json(body, result.outcome === "already_terminal" ? 409 : 202);
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
