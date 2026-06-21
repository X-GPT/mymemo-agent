/**
 * The seam that makes the client-visible stream a *projection* of the run's
 * recorded events. A {@link RunEventSink} that first records each run event
 * durably, then derives and emits the client-facing SSE frames from that same
 * event via {@link runEventToClientEvents}.
 *
 * Ordering and failure policy:
 * - The durable write happens before the SSE emit, so for an *intermediate*
 *   event a persistence failure aborts the lifecycle step (and therefore its
 *   frame) rather than streaming a frame for an event that was never recorded —
 *   fail closed.
 * - For a *terminal* event (`run_completed` / `run_failed` / `run_canceled`)
 *   the client-facing outcome must not hinge on the audit write: a failed
 *   durable append is logged but the derived frame is still emitted and the
 *   call resolves, so a log hiccup can never turn a finished turn into a
 *   client error (or silently drop its `done`/`error`).
 * - SSE send failures are always logged and swallowed — a broken client
 *   connection must not fail the run or corrupt its durable record.
 */

import { type RunEventSink, RunEventType } from "@/features/run-state";
import type { RunEvent, RunRef } from "@/features/workspace-store";
import type { ChatLogger } from "./chat.logger";
import type { MymemoEventSender } from "./chat.streaming";
import { runEventToClientEvents } from "./run-events-to-sse";

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
	RunEventType.Completed,
	RunEventType.Failed,
	RunEventType.Canceled,
]);

export function createSseRunEventSink(
	durable: RunEventSink,
	sender: MymemoEventSender,
	logger: ChatLogger,
): RunEventSink {
	return {
		async appendRunEvent(ref: RunRef, event: RunEvent): Promise<void> {
			try {
				await durable.appendRunEvent(ref, event);
			} catch (err) {
				// Intermediate events fail closed; terminal events fall through to
				// still emit their client frame (the run already reached its outcome).
				if (!TERMINAL_EVENT_TYPES.has(event.type)) throw err;
				logger.error({
					message:
						"Failed to persist terminal run event; emitting client frame anyway",
					eventType: event.type,
					error: err,
				});
			}
			for (const message of runEventToClientEvents(event)) {
				try {
					await sender.send({ id: crypto.randomUUID(), message });
				} catch (err) {
					logger.error({
						message: "Failed to send SSE event derived from run event",
						eventType: event.type,
						error: err,
					});
				}
			}
		},
	};
}
