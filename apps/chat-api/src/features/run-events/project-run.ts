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
	seq: number;
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
}

/**
 * Project a run's durable event log into the client SSE stream. Run-event replay
 * is the only SSE source: on every turn the loop reads `run_events` past the
 * cursor, emits the mapped frames, then waits for a `LISTEN/NOTIFY` wake-up or a
 * short poll timeout. Because it always reads before waiting, a missed
 * notification costs latency, never an event. The loop closes as soon as it
 * reads a terminal event — detection is by event *type*, so a terminal event
 * with an odd payload still ends the stream after emitting its frame.
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
	const subscription = await deps.notifier.subscribe(runId);
	try {
		let lastSeq = fromSeq;
		for (;;) {
			if (deps.signal?.aborted) return;
			const rows = await deps.reader.read(runId, lastSeq);
			for (const row of rows) {
				lastSeq = row.seq;
				const frames = projectRunEvent(row.type, row.payload);
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
			}
			if (!(await waitForWakeup(subscription, pollTimeoutMs, deps.signal))) {
				return;
			}
		}
	} finally {
		await subscription.close();
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
