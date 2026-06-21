/**
 * The seam that makes the client-visible stream a *projection* of the run's
 * recorded events. A {@link RunEventSink} that first records each run event
 * durably, then derives and emits the client-facing SSE frames from that same
 * event via {@link runEventToClientEvents}.
 *
 * Order matters: the durable write happens before the SSE emit, so a
 * persistence failure aborts the lifecycle step (and therefore its SSE) rather
 * than streaming a frame for an event that was never recorded. SSE send
 * failures are logged and swallowed — a broken client connection must not fail
 * the run or corrupt its durable record.
 */

import type { RunEventSink } from "@/features/run-state";
import type { RunEvent, RunRef } from "@/features/workspace-store";
import type { ChatLogger } from "./chat.logger";
import type { MymemoEventSender } from "./chat.streaming";
import { runEventToClientEvents } from "./run-events-to-sse";

export function createSseRunEventSink(
	durable: RunEventSink,
	sender: MymemoEventSender,
	logger: ChatLogger,
): RunEventSink {
	return {
		async appendRunEvent(ref: RunRef, event: RunEvent): Promise<void> {
			await durable.appendRunEvent(ref, event);
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
