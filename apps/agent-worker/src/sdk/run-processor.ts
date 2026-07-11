import type { RunRecord } from "@mymemo/agent-db/run-store";
import type { LiveTextPublisher } from "@mymemo/live-text";
import type { WorkerLogger } from "../logger";
import type { RunProcessor } from "../run-loop";
import { consumeAgentStream, type SupervisedQuery } from "./agent-stream";

/**
 * Start a Claude Agent SDK query for one claimed run. This is the seam between
 * run supervision (plan Task 7.2, this module) and everything a query needs that
 * later milestones own: the provisioned E2B sandbox and its clients, the bound
 * executor tools ({@link buildRunTools}), the OpenRouter model client, the docs
 * scope, and the resumed session. The returned handle is consumed under `signal`
 * — which the supervisor aborts on cancel, ownership loss, or shutdown, so the
 * query can be interrupted.
 */
export type StartRunQuery = (
	run: RunRecord,
	signal: AbortSignal,
) => Promise<SupervisedQuery>;

export interface SdkRunProcessorDeps {
	startRunQuery: StartRunQuery;
	logger: WorkerLogger;
	liveTextPublisher?: LiveTextPublisher;
}

/**
 * The Milestone 7 run processor: start the run's SDK query and consume its
 * stream under supervision, persisting complete Assistant messages as Run
 * events (plan Task 7.2). It slots into the same {@link RunProcessor} seam the
 * synthetic processor used, so the control loop's claim/heartbeat/terminalize
 * behavior — including mapping this processor's throw to `error` and a
 * supervisor-observed cancel to `canceled` — is unchanged.
 *
 * Message appends, terminal transitions, and the ownership fence all belong to
 * the loop and run store; this processor only assembles SDK provider envelopes,
 * reports the session to resume from next turn, and lets errors propagate.
 */
export function createSdkRunProcessor(deps: SdkRunProcessorDeps): RunProcessor {
	return async (ctx) => {
		if (!deps.liveTextPublisher) {
			try {
				deps.logger.info({ message: "Live preview disabled" });
			} catch {
				// Live telemetry must never change the Run outcome.
			}
		}
		const query = await deps.startRunQuery(ctx.run, ctx.signal);
		const outcome = await consumeAgentStream({
			runId: ctx.run.runId,
			query,
			signal: ctx.signal,
			appendAssistantMessage: ctx.appendAssistantMessage,
			liveTextPublisher: deps.liveTextPublisher,
			onLiveTextSignal: (signal) => {
				const event = {
					message: "Live preview transport state changed",
					signal,
				};
				if (signal === "recovered") deps.logger.info(event);
				else deps.logger.warn(event);
			},
			onPartialCompleteMismatch: () => {
				deps.logger.warn({
					message: "assistant Live preview disabled after text mismatch",
				});
			},
		});
		return {
			// Advance the conversation's resume pointer only when the SDK produced a
			// session id and no `mirror_error` left the stored transcript unreliable
			// (ADR-0005); otherwise the run still succeeds but the pointer holds.
			agentSession:
				outcome.sessionId !== null && !outcome.mirrorErrorObserved
					? { sessionId: outcome.sessionId }
					: null,
		};
	};
}
