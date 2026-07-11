import type { LiveTextMessage, LiveTextSubscription } from "@mymemo/live-text";
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
	/** Prepared before Run admission on the original request only. */
	liveSubscription?: LiveTextSubscription;
}

/**
 * Project a run's durable event log into the client SSE stream, optionally
 * merging cursorless Live preview on the original request. Durable Run events
 * remain the only authoritative and replayable source: on every turn the loop
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
	const pollTimeoutMs = deps.pollTimeoutMs ?? 1000;
	const durableSubscription = await deps.notifier.subscribe(runId);
	const expectedDeltaIndex = new Map<string, number>();
	const suppressedMessageIds = new Set<string>();
	const committedMessageIds = new Set<string>();
	let liveSubscription = deps.liveSubscription;
	let previewReady = false;
	let durableWakeup: Promise<boolean> | undefined;
	const disableLiveSubscription = async () => {
		const subscription = liveSubscription;
		liveSubscription = undefined;
		if (!subscription) return;
		try {
			await subscription.close();
		} catch {
			// Live preview is optional; durable projection stays authoritative.
		}
	};
	try {
		let lastSeq = fromSeq;
		for (;;) {
			if (deps.signal?.aborted) return;
			const rows = await deps.reader.read(runId, lastSeq);
			for (const row of rows) {
				lastSeq = row.seq;
				const frames = projectRunEvent(row.type, row.payload);
				for (const frame of frames) {
					if (frame.type === "text_commit") {
						committedMessageIds.add(frame.messageId);
						expectedDeltaIndex.delete(frame.messageId);
						suppressedMessageIds.delete(frame.messageId);
					}
				}
				for (const [index, frame] of frames.entries()) {
					const isLastSibling = index === frames.length - 1;
					yield {
						seq: row.seq,
						id: isLastSibling ? String(row.seq) : undefined,
						frame,
					};
					if (deps.signal?.aborted) return;
				}
				if (TERMINAL_RUN_EVENT_TYPES.has(row.type)) return;
				if (frames.some((frame) => frame.type === "run_id"))
					previewReady = true;
			}
			if (previewReady && liveSubscription) {
				let available: LiveTextMessage[];
				try {
					available = liveSubscription.readAvailable();
				} catch {
					await disableLiveSubscription();
					available = [];
				}
				for (const message of available) {
					if (
						message.runId !== runId ||
						committedMessageIds.has(message.messageId) ||
						suppressedMessageIds.has(message.messageId)
					) {
						continue;
					}
					const expected = expectedDeltaIndex.get(message.messageId) ?? 0;
					if (message.deltaIndex !== expected) {
						expectedDeltaIndex.delete(message.messageId);
						suppressedMessageIds.add(message.messageId);
						continue;
					}
					expectedDeltaIndex.set(message.messageId, expected + 1);
					yield {
						frame: {
							type: "text_delta",
							messageId: message.messageId,
							deltaIndex: message.deltaIndex,
							text: message.text,
						},
					};
					if (deps.signal?.aborted) return;
				}
			}
			if (!liveSubscription) {
				if (
					!(await waitForWakeup(
						durableSubscription,
						pollTimeoutMs,
						deps.signal,
					))
				) {
					return;
				}
				continue;
			}

			durableWakeup ??= waitForWakeup(
				durableSubscription,
				pollTimeoutMs,
				deps.signal,
			);
			const liveWaitController = new AbortController();
			const onAbort = () => liveWaitController.abort();
			deps.signal?.addEventListener("abort", onAbort, { once: true });
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
			deps.signal?.removeEventListener("abort", onAbort);
			if (winner.source === "durable") durableWakeup = undefined;
			if (winner.source === "live" && winner.failed) {
				await disableLiveSubscription();
			}
			if (!winner.open && deps.signal?.aborted) {
				return;
			}
		}
	} finally {
		try {
			await durableSubscription.close();
		} finally {
			await disableLiveSubscription();
		}
	}
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
