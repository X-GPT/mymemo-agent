import type { RunRecord } from "@mymemo/agent-db/run-store";
import type { LiveTextPublisher, LiveTextTelemetry } from "@mymemo/live-text";
import type {
	ArtifactAwareQuery,
	ArtifactPublication,
} from "../artifacts/artifact-publication";
import {
	createWorkerLiveTextTelemetry,
	reportWorkerLiveTextPreviewSignal,
} from "../live-text";
import type { WorkerLogger } from "../logger";
import type { RunProcessor } from "../run-loop";
import {
	type AgentStreamOutcome,
	consumeAgentStream,
	type SupervisedQuery,
} from "./agent-stream";
import { AssistantEnvelopeProtocolError } from "./assistant-message-assembler";

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
) => Promise<SupervisedQuery & Partial<ArtifactAwareQuery>>;

export interface SdkRunProcessorDeps {
	startRunQuery: StartRunQuery;
	logger: WorkerLogger;
	liveTextPublisher?: LiveTextPublisher;
	liveTextTelemetry?: LiveTextTelemetry;
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
	const telemetry =
		deps.liveTextTelemetry ?? createWorkerLiveTextTelemetry(deps.logger);
	return async (ctx) => {
		const query = await deps.startRunQuery(ctx.run, ctx.signal);
		let outcome: AgentStreamOutcome;
		try {
			outcome = await consumeAgentStream({
				runId: ctx.run.runId,
				query,
				signal: ctx.signal,
				appendModelContent: ctx.appendModelContent,
				appendLiveEvent: ctx.appendLiveEvent,
				logger: deps.logger,
				liveTextPublisher: deps.liveTextPublisher,
				onLiveTextSignal: (signal) =>
					reportWorkerLiveTextPreviewSignal(telemetry, signal),
				onPartialCompleteMismatch: () => {
					telemetry.record("mismatch", "partial_complete");
				},
			});
		} catch (error) {
			if (error instanceof AssistantEnvelopeProtocolError) {
				telemetry.record("impossible_ordering", "provider_envelope");
			}
			throw error;
		}
		return {
			// Advance the conversation's resume pointer only when the SDK produced a
			// session id and no `mirror_error` left the stored transcript unreliable
			// (ADR-0005); otherwise the run still succeeds but the pointer holds.
			agentSession:
				outcome.sessionId !== null && !outcome.mirrorErrorObserved
					? { sessionId: outcome.sessionId }
					: null,
			artifactPublication:
				(query.getArtifactPublication?.() as ArtifactPublication | null) ??
				null,
		};
	};
}
