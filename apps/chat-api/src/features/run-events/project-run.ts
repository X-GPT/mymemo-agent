import {
	LiveTextMessageSchema,
	type LiveTextSubscription,
} from "@mymemo/live-text";
import { projectRunEvent } from "./project-run-event";
import type { RunEventReader } from "./run-event-reader";
import type { ClientFrame } from "./run-event-types";
import { TERMINAL_RUN_EVENT_TYPES } from "./run-event-types";
import type { RunNotifier } from "./run-notifier";

/**
 * One client SSE frame plus its optional durable cursor. When one run event
 * fans out to several client frames, only the final sibling receives the
 * event's `seq` as its SSE `id:`. If a connection drops mid-fanout, the browser
 * keeps the previous durable id and replay can deliver the whole fanout again.
 */
export interface ProjectedFrame {
	seq?: number;
	id?: string;
	frame: ClientFrame;
}

export interface ProjectRunDeps {
	reader: RunEventReader;
	notifier: RunNotifier;
	signal?: AbortSignal;
	/**
	 * Ceiling on how long a loop turn waits for a wake-up before re-reading the
	 * table anyway. This is what makes the projector tolerant of missed
	 * notifications; keep it short (1-2s). Default 1000ms.
	 */
	pollTimeoutMs?: number;
	/** Prepared before admission, or after authorizing an active reconnect. */
	liveSubscription?: LiveTextSubscription;
	/** Bound on provisional frames waiting for a slow SSE consumer. */
	maxPreviewQueueMessages?: number;
	/** Bound on durable frames before this replayable connection is ended. */
	maxDurableQueueMessages?: number;
	/** Payload-free, fixed-vocabulary Live preview degradation signal. */
	onLiveTextSignal?: (signal: ProjectRunLiveTextSignal) => void;
}

export const DEFAULT_MAX_PREVIEW_QUEUE_MESSAGES = 64;
export const DEFAULT_MAX_DURABLE_QUEUE_MESSAGES = 256;

export type ProjectRunLiveTextSignal =
	| "duplicate_inconsistency"
	| "durable_backlog"
	| "gap"
	| "impossible_ordering"
	| "late_delta"
	| "malformed_message"
	| "message_attempted"
	| "message_delivered"
	| "message_dropped"
	| "partial_complete_mismatch"
	| "queue_overflow"
	| "reconciliation_overflow"
	| "subscriber_failure"
	| "terminal_open_preview";

interface PreviewState {
	expectedDeltaIndex: number;
	chunks: string[];
}

class ProjectionOutput {
	readonly #durable: ProjectedFrame[] = [];
	readonly #preview: ProjectedFrame[] = [];
	readonly #waiters = new Set<() => void>();
	#finished = false;
	#error: unknown;

	constructor(
		private readonly maxPreviewQueueMessages: number,
		private readonly maxDurableQueueMessages: number,
	) {}

	pushDurable(frame: ProjectedFrame): boolean {
		if (this.#durable.length >= this.maxDurableQueueMessages) return false;
		this.#durable.push(frame);
		this.#wake();
		return true;
	}

	pushPreview(frame: ProjectedFrame): boolean {
		if (this.#preview.length >= this.maxPreviewQueueMessages) return false;
		this.#preview.push(frame);
		this.#wake();
		return true;
	}

	purgePreview(messageId: string): void {
		for (let index = this.#preview.length - 1; index >= 0; index--) {
			const frame = this.#preview[index]?.frame;
			if (frame?.type === "text_delta" && frame.messageId === messageId) {
				this.#preview.splice(index, 1);
			}
		}
	}

	clearPreview(): void {
		this.#preview.length = 0;
	}

	hasPreview(): boolean {
		return this.#preview.length > 0;
	}

	finish(error?: unknown): void {
		this.#finished = true;
		this.#error = error;
		this.#wake();
	}

	async take(signal: AbortSignal): Promise<ProjectedFrame | undefined> {
		for (;;) {
			const durable = this.#durable.shift();
			if (durable) return durable;
			const preview = this.#preview.shift();
			if (preview) return preview;
			if (this.#error !== undefined) throw this.#error;
			if (this.#finished || signal.aborted) return undefined;
			await new Promise<void>((resolve) => {
				const finish = () => {
					this.#waiters.delete(finish);
					signal.removeEventListener("abort", finish);
					resolve();
				};
				this.#waiters.add(finish);
				signal.addEventListener("abort", finish, { once: true });
			});
		}
	}

	#wake(): void {
		for (const wake of this.#waiters) wake();
		this.#waiters.clear();
	}
}

/**
 * Project a run's durable event log into the client SSE stream, optionally
 * merging cursorless Live preview on the original request or an authorized
 * active-Run reconnect. Durable Run events remain the only authoritative and
 * replayable source: on every turn the loop
 * reads `run_events` past the cursor, emits the mapped frames, then waits for a
 * durable or Live wake-up (or a short poll timeout). Because it always reads
 * before waiting, a missed durable notification costs latency, never an event.
 * The loop closes as soon as it reads a terminal event — detection is by event
 * *type*, so a terminal event with an odd payload still ends the stream after
 * emitting its frame.
 *
 * The event-type→frame mapping ({@link projectRunEvent}) is the single authority
 * for client exposure: unmapped internal event types yield no frame and cannot
 * leak to clients.
 */
export async function* projectRun(
	runId: string,
	fromSeq: number,
	deps: ProjectRunDeps,
): AsyncGenerator<ProjectedFrame> {
	const maxPreviewQueueMessages =
		deps.maxPreviewQueueMessages ?? DEFAULT_MAX_PREVIEW_QUEUE_MESSAGES;
	const maxDurableQueueMessages =
		deps.maxDurableQueueMessages ?? DEFAULT_MAX_DURABLE_QUEUE_MESSAGES;
	if (
		!Number.isSafeInteger(maxPreviewQueueMessages) ||
		maxPreviewQueueMessages < 1 ||
		!Number.isSafeInteger(maxDurableQueueMessages) ||
		maxDurableQueueMessages < 1
	) {
		throw new Error("Projection queue bounds must be positive integers");
	}
	const output = new ProjectionOutput(
		maxPreviewQueueMessages,
		maxDurableQueueMessages,
	);
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (deps.signal?.aborted) controller.abort();
	else deps.signal?.addEventListener("abort", onAbort, { once: true });

	const producer = produceRun(
		runId,
		fromSeq,
		deps,
		output,
		controller.signal,
	).then(
		() => output.finish(),
		(error) => output.finish(error),
	);
	try {
		for (;;) {
			const projected = await output.take(controller.signal);
			if (!projected) return;
			yield projected;
		}
	} finally {
		controller.abort();
		deps.signal?.removeEventListener("abort", onAbort);
		await producer;
	}
}

async function produceRun(
	runId: string,
	fromSeq: number,
	deps: ProjectRunDeps,
	output: ProjectionOutput,
	signal: AbortSignal,
): Promise<void> {
	const pollTimeoutMs = deps.pollTimeoutMs ?? 1000;
	const maxPreviewQueueMessages =
		deps.maxPreviewQueueMessages ?? DEFAULT_MAX_PREVIEW_QUEUE_MESSAGES;
	const maxDurableQueueMessages =
		deps.maxDurableQueueMessages ?? DEFAULT_MAX_DURABLE_QUEUE_MESSAGES;
	const durableSubscription = await deps.notifier.subscribe(runId);
	const previewStates = new Map<string, PreviewState>();
	const suppressedMessageIds = new Set<string>();
	const committedMessageIds = new Set<string>();
	const activeOutcomeMessageIds = new Set<string>();
	let liveSubscription = deps.liveSubscription;
	let liveSubscriptionClose = Promise.resolve();
	let previewReady = fromSeq > 0;
	let durableWakeup: Promise<boolean> | undefined;
	const emitSignal = (liveSignal: ProjectRunLiveTextSignal) => {
		try {
			deps.onLiveTextSignal?.(liveSignal);
		} catch {
			// Telemetry is optional and cannot change durable projection.
		}
	};
	const disableLiveSubscription = () => {
		const subscription = liveSubscription;
		liveSubscription = undefined;
		if (!subscription) return;
		try {
			const closing = subscription.close().catch(() => {});
			liveSubscriptionClose = Promise.all([
				liveSubscriptionClose,
				closing,
			]).then(() => {});
		} catch {
			// Live preview is optional; durable projection stays authoritative.
		}
	};
	const suppressMessage = (messageId: string) => {
		previewStates.delete(messageId);
		output.purgePreview(messageId);
		if (activeOutcomeMessageIds.delete(messageId)) {
			emitSignal("message_dropped");
		}
		if (suppressedMessageIds.has(messageId)) return;
		if (suppressedMessageIds.size >= maxPreviewQueueMessages) {
			emitSignal("queue_overflow");
			suppressedMessageIds.clear();
			output.clearPreview();
			disableLiveSubscription();
			return;
		}
		suppressedMessageIds.add(messageId);
	};
	const disableLiveForRun = () => {
		for (const _messageId of activeOutcomeMessageIds) {
			emitSignal("message_dropped");
		}
		activeOutcomeMessageIds.clear();
		previewStates.clear();
		suppressedMessageIds.clear();
		output.clearPreview();
		disableLiveSubscription();
	};
	try {
		let lastSeq = fromSeq;
		for (;;) {
			if (signal.aborted) return;
			const rows = await deps.reader.read(
				runId,
				lastSeq,
				maxDurableQueueMessages,
			);
			for (const row of rows) {
				lastSeq = row.seq;
				const frames = projectRunEvent(row.type, row.payload);
				for (const frame of frames) {
					if (frame.type === "text_commit") {
						if (
							liveSubscription &&
							!committedMessageIds.has(frame.messageId) &&
							committedMessageIds.size >= maxPreviewQueueMessages
						) {
							emitSignal("reconciliation_overflow");
							committedMessageIds.clear();
							disableLiveForRun();
						}
						if (liveSubscription) committedMessageIds.add(frame.messageId);
						output.purgePreview(frame.messageId);
						const state = previewStates.get(frame.messageId);
						if (
							state &&
							!suppressedMessageIds.has(frame.messageId) &&
							state.chunks.join("") !== frame.text
						) {
							if (activeOutcomeMessageIds.delete(frame.messageId)) {
								emitSignal("message_dropped");
							}
							emitSignal("partial_complete_mismatch");
							disableLiveForRun();
						} else if (
							state &&
							activeOutcomeMessageIds.delete(frame.messageId)
						) {
							emitSignal("message_delivered");
						}
						previewStates.delete(frame.messageId);
						suppressedMessageIds.delete(frame.messageId);
					}
				}
				const isTerminal = TERMINAL_RUN_EVENT_TYPES.has(row.type);
				if (isTerminal) {
					if (previewStates.size > 0 || output.hasPreview()) {
						emitSignal("terminal_open_preview");
					}
					disableLiveForRun();
				}
				for (const [index, frame] of frames.entries()) {
					const isLastSibling = index === frames.length - 1;
					if (
						!output.pushDurable({
							seq: row.seq,
							id: isLastSibling ? String(row.seq) : undefined,
							frame,
						})
					) {
						emitSignal("durable_backlog");
						disableLiveForRun();
						return;
					}
					if (signal.aborted) return;
				}
				if (isTerminal) return;
				if (frames.some((frame) => frame.type === "run_id"))
					previewReady = true;
			}
			if (previewReady && liveSubscription) {
				let available: unknown[];
				try {
					const subscription = liveSubscription;
					const droppedMessages = subscription.readDroppedMessages();
					if (droppedMessages.type === "invalid_wire_message") {
						emitSignal("malformed_message");
						disableLiveForRun();
						available = [];
					} else if (droppedMessages.type === "tracking_overflow") {
						emitSignal("queue_overflow");
						disableLiveForRun();
						available = [];
					} else {
						for (const messageId of droppedMessages.messageIds) {
							suppressMessage(messageId);
							emitSignal("queue_overflow");
						}
						available = liveSubscription ? subscription.readAvailable() : [];
					}
				} catch {
					emitSignal("subscriber_failure");
					disableLiveSubscription();
					available = [];
				}
				for (const rawMessage of available) {
					if (!liveSubscription) break;
					const parsed = LiveTextMessageSchema.safeParse(rawMessage);
					if (!parsed.success) {
						emitSignal("malformed_message");
						const messageId = malformedMessageId(rawMessage);
						if (messageId) suppressMessage(messageId);
						else disableLiveForRun();
						continue;
					}
					const message = parsed.data;
					if (message.runId !== runId) {
						emitSignal("impossible_ordering");
						disableLiveForRun();
						break;
					}
					if (committedMessageIds.has(message.messageId)) {
						emitSignal("late_delta");
						continue;
					}
					if (suppressedMessageIds.has(message.messageId)) {
						continue;
					}
					if (!activeOutcomeMessageIds.has(message.messageId)) {
						activeOutcomeMessageIds.add(message.messageId);
						emitSignal("message_attempted");
					}
					let state = previewStates.get(message.messageId);
					if (!state) {
						if (message.deltaIndex !== 0) {
							suppressMessage(message.messageId);
							emitSignal("gap");
							continue;
						}
						if (previewStates.size >= maxPreviewQueueMessages) {
							emitSignal("queue_overflow");
							disableLiveForRun();
							break;
						}
						state = { expectedDeltaIndex: 0, chunks: [] };
						previewStates.set(message.messageId, state);
					}
					if (message.deltaIndex < state.expectedDeltaIndex) {
						if (state.chunks[message.deltaIndex] !== message.text) {
							suppressMessage(message.messageId);
							emitSignal("duplicate_inconsistency");
						}
						continue;
					}
					if (message.deltaIndex > state.expectedDeltaIndex) {
						suppressMessage(message.messageId);
						emitSignal("gap");
						continue;
					}
					if (state.chunks.length >= maxPreviewQueueMessages) {
						suppressMessage(message.messageId);
						emitSignal("queue_overflow");
						continue;
					}
					state.chunks.push(message.text);
					state.expectedDeltaIndex++;
					if (
						!output.pushPreview({
							frame: {
								type: "text_delta",
								messageId: message.messageId,
								deltaIndex: message.deltaIndex,
								text: message.text,
							},
						})
					) {
						suppressMessage(message.messageId);
						emitSignal("queue_overflow");
					}
					if (signal.aborted) return;
				}
				// Let a ready SSE consumer drain preview before polling durable state
				// again, while still allowing the producer to advance independently
				// when that consumer is slow.
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			if (!liveSubscription) {
				if (
					!(await waitForWakeup(durableSubscription, pollTimeoutMs, signal))
				) {
					return;
				}
				continue;
			}

			durableWakeup ??= waitForWakeup(
				durableSubscription,
				pollTimeoutMs,
				signal,
			);
			const liveWaitController = new AbortController();
			const onAbort = () => liveWaitController.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			const currentLiveSubscription = liveSubscription;
			const winner = await Promise.race([
				durableWakeup.then((open) => ({ source: "durable" as const, open })),
				currentLiveSubscription
					.waitForMessage({
						timeoutMs: pollTimeoutMs,
						signal: liveWaitController.signal,
					})
					.then(
						(open) => ({ source: "live" as const, open, failed: false }),
						() => ({ source: "live" as const, open: false, failed: true }),
					),
			]);
			liveWaitController.abort();
			signal.removeEventListener("abort", onAbort);
			if (winner.source === "durable") durableWakeup = undefined;
			if (winner.source === "live" && winner.failed) {
				emitSignal("subscriber_failure");
				disableLiveSubscription();
			}
			if (!winner.open && signal.aborted) {
				return;
			}
		}
	} finally {
		try {
			await durableSubscription.close();
		} finally {
			disableLiveSubscription();
			await liveSubscriptionClose;
		}
	}
}

function malformedMessageId(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return null;
	const messageId = (value as { messageId?: unknown }).messageId;
	return typeof messageId === "string" && messageId.length > 0
		? messageId
		: null;
}

async function waitForWakeup(
	subscription: Awaited<ReturnType<RunNotifier["subscribe"]>>,
	pollTimeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (!signal) {
		await subscription.waitForWakeup(pollTimeoutMs);
		return true;
	}
	if (signal.aborted) return false;

	return new Promise<boolean>((resolve, reject) => {
		const onAbort = () => resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		subscription.waitForWakeup(pollTimeoutMs).then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve(!signal.aborted);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
