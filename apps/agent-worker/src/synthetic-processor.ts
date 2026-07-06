import type { RunProcessor } from "./run-loop";

/**
 * Milestone 3's synthetic turn: append one `assistant_text` run event — which
 * chat-api's projector maps to the client's `text_delta` SSE frame — so the
 * stream shows streamed text ahead of `done`, restoring the end-to-end demo
 * after the hard swap to the split runtime. It performs no model or E2B work;
 * the Claude Agent SDK loop replaces this processor in Milestone 7.
 *
 * If cancellation was already observed before processing began, it appends
 * nothing — the loop will terminalize the run as `canceled`.
 */
export const syntheticProcessor: RunProcessor = async (ctx) => {
	if (ctx.signal.aborted) return;
	await ctx.appendText(
		`Synthetic response for run ${ctx.run.runId} in conversation ${ctx.run.conversationId}.`,
	);
};
