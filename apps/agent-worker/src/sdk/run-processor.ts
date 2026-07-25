import type { RunRecord } from "@mymemo/agent-db/run-store";
import type {
	ArtifactAwareQuery,
	ArtifactPublication,
} from "../artifacts/artifact-publication";
import type { WorkerLogger } from "../logger";
import type { RunProcessor } from "../run-loop";
import {
	type AgentStreamOutcome,
	consumeAgentStream,
	type StartStopDeadline,
	type SupervisedQuery,
} from "./agent-stream";

/**
 * Start a Claude Agent SDK query for one claimed run. This is the seam between
 * run supervision (plan Task 7.2, this module) and everything a query needs that
 * later milestones own: the provisioned E2B sandbox and its clients, the bound
 * executor tools ({@link buildRunTools}), the OpenRouter model client, the docs
 * scope, and the resumed session. The returned handle is consumed under `signal`
 * — which the supervisor aborts on interruption, ownership loss, or shutdown, so the
 * query can be interrupted.
 */
export type StartRunQuery = (
	run: RunRecord,
	signal: AbortSignal,
) => Promise<SupervisedQuery & Partial<ArtifactAwareQuery>>;

export interface SdkRunProcessorDeps {
	startRunQuery: StartRunQuery;
	logger: WorkerLogger;
	supervisedQueryOptions?: SupervisedQueryOptions;
}

export interface SupervisedQueryOptions {
	startStopDeadline?: StartStopDeadline;
}

/**
 * The Milestone 7 run processor: start the run's SDK query and consume its
 * stream under supervision, persisting complete Assistant messages as Run
 * events (plan Task 7.2). It slots into the same {@link RunProcessor} seam the
 * synthetic processor used, so the control loop's claim/heartbeat/terminalize
 * behavior — including mapping this processor's throw to `error` and a
 * supervisor-observed interruption to `interrupted` — is unchanged.
 *
 * Message appends, terminal transitions, and the ownership fence all belong to
 * the loop and run store; this processor only assembles SDK provider envelopes,
 * reports the session to resume from next turn, and lets errors propagate.
 */
export function createSdkRunProcessor(deps: SdkRunProcessorDeps): RunProcessor {
	return async (ctx) => {
		const query = await deps.startRunQuery(ctx.run, ctx.signal);
		const outcome: AgentStreamOutcome = await consumeAgentStream({
			runId: ctx.run.runId,
			query,
			signal: ctx.signal,
			ownershipLostSignal: ctx.ownershipLostSignal,
			appendModelContents: ctx.appendModelContents,
			appendLiveEvent: ctx.appendLiveEvent,
			logger: deps.logger,
			startStopDeadline: deps.supervisedQueryOptions?.startStopDeadline,
		});
		const { disposition, ...streamMetadata } = outcome;
		return {
			disposition,
			streamMetadata,
			artifactPublication:
				disposition === "completed"
					? ((query.getArtifactPublication?.() as ArtifactPublication | null) ??
						null)
					: null,
		};
	};
}
