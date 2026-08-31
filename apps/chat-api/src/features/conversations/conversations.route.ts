import { setTimeout as delay } from "node:timers/promises";
import { sValidator as zValidator } from "@hono/standard-validator";
import {
	RunInputMismatchError,
	type RunRecord,
} from "@mymemo/agent-db/run-store";
import {
	classifyLiveStreamFailure,
	type LiveStreamAttachResult,
	type LiveStreamReason,
} from "@mymemo/live-text";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import {
	ActiveRunExistsError,
	ConversationArchivedError,
	ConversationNotFoundError,
} from "@/features/run-store/run-store";
import { admitAgUiRun } from "./conversations.controller";
import {
	ConversationIdParam,
	MAX_REQUEST_BODY_BYTES,
	RunAgentInputBody,
	RunIdParam,
} from "./conversations.schema";
import { requireInternalIdentity } from "./internal-identity";

const app = new Hono<AppEnv>();

/** Request-body cap for Run admission. */
const conversationBodyLimit = bodyLimit({
	maxSize: MAX_REQUEST_BODY_BYTES,
	onError: (c) => c.json({ error: "Request body too large" }, 413),
});
const ConversationPath = z.object({ conversationId: ConversationIdParam });
const RunPath = z.object({
	conversationId: ConversationIdParam,
	runId: RunIdParam,
});

const LIVE_STREAM_START_POLL_MS = 100;
const LIVE_STREAM_MAX_RETRY_MS = 1_000;
const LIVE_STREAM_KEEPALIVE_MS = 5_000;
const LIVE_STREAM_RECOVERY_POLL_MS = LIVE_STREAM_KEEPALIVE_MS;
const liveStreamDecoder = new TextDecoder("utf-8", { fatal: true });

function isTerminalRunStatus(status: RunRecord["status"]): boolean {
	return status === "done" || status === "error" || status === "interrupted";
}

function needsLiveStreamRecovery(run: RunRecord): boolean {
	return run.liveStreamFailedAt !== null || isTerminalRunStatus(run.status);
}

function cannotUseLiveStream(run: RunRecord | null): boolean {
	return run === null || needsLiveStreamRecovery(run);
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
	if (needsLiveStreamRecovery(currentRun)) {
		return liveStreamRecoveryResponse(c);
	}
	c.var.deps.liveStreamTelemetry.record("reconnect_response", "retryable_503", {
		reason,
	});
	return c.json({ error: "Live stream temporarily unavailable" }, 503);
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	try {
		await delay(ms, undefined, { signal });
	} catch (error) {
		if (!signal.aborted) throw error;
	}
}

function linkedAbortController(parent: AbortSignal): {
	controller: AbortController;
	signal: AbortSignal;
} {
	const controller = new AbortController();
	return { controller, signal: AbortSignal.any([parent, controller.signal]) };
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

function watchRunForLiveStreamRecovery(
	c: Context<AppEnv>,
	run: RunRecord,
	readController: AbortController,
): () => void {
	let checking = false;
	let stopped = false;
	const interval = setInterval(() => {
		if (checking || stopped || readController.signal.aborted) return;
		checking = true;
		void c.var.deps.runStore
			.getRun({
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
			})
			.then((currentRun) => {
				// Terminal state may commit just before its live terminal publish. If
				// this poll wins that race, the incomplete close recovers via history.
				if (cannotUseLiveStream(currentRun)) {
					readController.abort();
				}
			})
			.catch(() => {
				c.var.logger.error({
					message: "AG-UI Live Stream recovery watch failed",
					runId: run.runId,
					reason: "run_state_read_failed",
				});
			})
			.finally(() => {
				checking = false;
			});
	}, LIVE_STREAM_RECOVERY_POLL_MS);
	return () => {
		stopped = true;
		clearInterval(interval);
	};
}

async function writeAgUiEvents(
	c: Context<AppEnv>,
	runId: string,
	iterator: AsyncIterator<Uint8Array>,
	first: IteratorResult<Uint8Array>,
	writeSSE: (event: { data: string }) => Promise<unknown>,
): Promise<void> {
	let next = first;
	try {
		while (!next.done) {
			if (c.req.raw.signal.aborted) break;
			await writeSSE({
				data: liveStreamDecoder.decode(next.value),
			});
			next = await iterator.next();
		}
	} catch (error) {
		c.var.logger.error({
			message: "AG-UI Live Stream read failed",
			runId,
			reason: classifyLiveStreamFailure(error),
		});
	}
}

type AttachedFirstRead =
	| { outcome: "event"; first: IteratorYieldResult<Uint8Array> }
	| { outcome: "ended" }
	| { outcome: "error"; error: unknown };

interface AttachedAgUiReader {
	firstRead: Promise<AttachedFirstRead>;
	streamEventsTo(
		writeSSE: (event: { data: string }) => Promise<unknown>,
		readFailureMessage: string,
		firstRead?: AttachedFirstRead,
	): Promise<void>;
	close(): Promise<void>;
}

function openAttachedAgUiReader(
	c: Context<AppEnv>,
	run: RunRecord,
	events: AsyncIterable<Uint8Array>,
	readController: AbortController,
): AttachedAgUiReader {
	const iterator = events[Symbol.asyncIterator]();
	const stopRecoveryWatch = watchRunForLiveStreamRecovery(
		c,
		run,
		readController,
	);
	const firstRead = iterator.next().then(
		(result): AttachedFirstRead =>
			result.done ? { outcome: "ended" } : { outcome: "event", first: result },
		(error: unknown): AttachedFirstRead => ({ outcome: "error", error }),
	);
	let closed = false;

	return {
		firstRead,
		async streamEventsTo(writeSSE, readFailureMessage, initial) {
			const first = initial ?? (await firstRead);
			if (first.outcome === "error") {
				c.var.logger.error({
					message: readFailureMessage,
					runId: run.runId,
					reason: classifyLiveStreamFailure(first.error),
				});
				return;
			}
			if (first.outcome === "ended") return;
			await writeAgUiEvents(c, run.runId, iterator, first.first, writeSSE);
		},
		async close() {
			if (closed) return;
			closed = true;
			stopRecoveryWatch();
			await iterator.return?.();
		},
	};
}

function streamAttachedAgUiReader(
	c: Context<AppEnv>,
	run: RunRecord,
	readAbort: ReturnType<typeof linkedAbortController>,
	reader: AttachedAgUiReader,
	options: {
		firstRead?: AttachedFirstRead;
		writeInitialPing?: boolean;
	} = {},
) {
	return streamSSE(c, async (stream) => {
		stream.onAbort(() => readAbort.controller.abort());
		let stopKeepalive = () => {};
		try {
			if (options.writeInitialPing) await stream.write(": ping\n\n");
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
			await reader.streamEventsTo(
				(event) => stream.writeSSE(event),
				"AG-UI Live Stream read failed",
				options.firstRead,
			);
		} finally {
			stopKeepalive();
			await reader.close();
			readAbort.controller.abort();
		}
	});
}

async function streamAgUiRun(
	c: Context<AppEnv>,
	run: RunRecord,
	events: AsyncIterable<Uint8Array>,
	readAbort: ReturnType<typeof linkedAbortController>,
) {
	const requestSignal = c.req.raw.signal;
	const reader = openAttachedAgUiReader(c, run, events, readAbort.controller);
	const initial = await Promise.race([
		reader.firstRead,
		abortableDelay(LIVE_STREAM_KEEPALIVE_MS, requestSignal).then(() => ({
			outcome: "ping" as const,
		})),
	]);
	if (initial.outcome === "error") {
		const { error } = initial;
		await reader.close();
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
			await reader.close();
			return c.body(null, 204);
		}
		return streamAttachedAgUiReader(c, run, readAbort, reader, {
			writeInitialPing: true,
		});
	}
	if (initial.outcome === "ended") {
		await reader.close();
		if (requestSignal.aborted) return c.body(null, 204);
		return liveStreamReadFailureResponse(c, run, "relay_failed");
	}

	return streamAttachedAgUiReader(c, run, readAbort, reader, {
		firstRead: initial,
	});
}

async function waitForAndStreamAgUiRun(c: Context<AppEnv>, run: RunRecord) {
	const requestSignal = c.req.raw.signal;
	const currentRun = await c.var.deps.runStore.getRun({
		userId: run.userId,
		conversationId: run.conversationId,
		runId: run.runId,
	});
	if (currentRun === null) return c.json({ error: "Run not found" }, 404);
	if (needsLiveStreamRecovery(currentRun)) {
		return liveStreamRecoveryResponse(c);
	}
	return streamSSE(c, async (stream) => {
		const readAbort = linkedAbortController(requestSignal);
		const readSignal = readAbort.signal;
		let retryDelayMs = LIVE_STREAM_START_POLL_MS;
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
				if (cannotUseLiveStream(currentRun)) return;

				c.var.deps.liveStreamTelemetry.record("attach_attempt", "retry");
				await abortableDelay(retryDelayMs, readSignal);
				if (readSignal.aborted) return;
				let attached: LiveStreamAttachResult;
				try {
					attached = await c.var.deps.liveStreamRelay.attach(
						run.runId,
						readSignal,
					);
				} catch (error) {
					c.var.logger.error({
						message: "AG-UI Live Stream attach failed while retrying",
						runId: run.runId,
						reason: classifyLiveStreamFailure(error),
					});
					return;
				}
				if (attached.outcome === "aborted") return;
				if (attached.outcome === "relay_failed") return;
				if (attached.outcome === "no_producer") {
					retryDelayMs = Math.min(retryDelayMs * 2, LIVE_STREAM_MAX_RETRY_MS);
					continue;
				}
				const reader = openAttachedAgUiReader(
					c,
					run,
					attached.events,
					readAbort.controller,
				);
				try {
					await reader.streamEventsTo(
						(event) => stream.writeSSE(event),
						"AG-UI Live Stream read failed after attaching",
					);
					return;
				} finally {
					await reader.close();
				}
			}
		} finally {
			stopKeepalive();
			readAbort.controller.abort();
		}
	});
}

async function respondWithAgUiRun(c: Context<AppEnv>, run: RunRecord) {
	if (needsLiveStreamRecovery(run)) return liveStreamRecoveryResponse(c);

	const readAbort = linkedAbortController(c.req.raw.signal);
	let attached: LiveStreamAttachResult;
	try {
		attached = await c.var.deps.liveStreamRelay.attach(
			run.runId,
			readAbort.signal,
		);
	} catch (error) {
		readAbort.controller.abort();
		return liveStreamReadFailureResponse(
			c,
			run,
			classifyLiveStreamFailure(error),
		);
	}
	if (attached.outcome === "attached") {
		return streamAgUiRun(c, run, attached.events, readAbort);
	}
	readAbort.controller.abort();
	if (attached.outcome === "no_producer")
		return waitForAndStreamAgUiRun(c, run);
	if (attached.outcome === "aborted") return c.body(null, 204);
	return liveStreamReadFailureResponse(c, run, "relay_failed");
}

// POST /v1/conversations/:conversationId/runs — atomically admit one strict
// standard AG-UI Run and attach to its producer-buffered Live Stream relay.
app.post(
	"/:conversationId/runs",
	conversationBodyLimit,
	zValidator("param", ConversationPath, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid conversation id" }, 400);
		}
	}),
	zValidator("json", RunAgentInputBody, (result, c) => {
		if (!result.success) {
			return c.json(
				{ error: "Invalid RunAgentInput", issues: result.error },
				400,
			);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const { conversationId } = c.req.valid("param");
		const input = c.req.valid("json");
		if (input.threadId !== conversationId) {
			return c.json({ error: "threadId must match the Conversation id" }, 400);
		}
		const conversation = await c.var.deps.conversationStore.get({
			userId: c.var.identity.memberCode,
			conversationId,
		});
		if (!conversation) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		const existingRun = await c.var.deps.runStore.getRun({
			userId: c.var.identity.memberCode,
			conversationId,
			runId: input.runId,
		});
		if (
			existingRun === null &&
			!(await c.var.deps.exposureGate.isAgentEnabled(c.var.identity))
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

		return respondWithAgUiRun(c, admittedRun);
	},
);

// POST /v1/conversations/:conversationId/runs/:runId/interrupt — durably
// interrupt an owned Run without admitting new work or opening an SSE
// response. Canonical Run control (ADR-0013): a queued Run terminalizes
// `interrupted` directly; a running Run becomes `interrupt_requested`; both
// answers stay retry-safe across the terminal transition.
app.post(
	"/:conversationId/runs/:runId/interrupt",
	zValidator("param", RunPath, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid conversation or Run id" }, 400);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const { conversationId, runId } = c.req.valid("param");
		const result = await c.var.deps.runStore.requestInterruption({
			userId: c.var.identity.memberCode,
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
	zValidator("param", RunPath, (result, c) => {
		if (!result.success) {
			return c.json({ error: "Invalid conversation or run id" }, 400);
		}
	}),
	requireInternalIdentity,
	async (c) => {
		const { conversationId, runId } = c.req.valid("param");
		const conversation = await c.var.deps.conversationStore.get({
			userId: c.var.identity.memberCode,
			conversationId,
		});
		if (!conversation) {
			return c.json({ error: "Conversation not found" }, 404);
		}

		const run = await c.var.deps.runStore.getRun({
			userId: c.var.identity.memberCode,
			conversationId,
			runId,
		});
		if (!run) {
			return c.json({ error: "Run not found" }, 404);
		}
		return respondWithAgUiRun(c, run);
	},
);

export default app;
