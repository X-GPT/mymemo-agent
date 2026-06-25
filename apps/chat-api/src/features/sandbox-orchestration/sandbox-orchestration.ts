import { type LlmTokenClaims, mintLlmToken } from "@mymemo/llm-token";
import type { ChatMessagesScope } from "@/config/env";
import type { AppDeps } from "@/deps";
import { buildSandboxAgentPrompt } from "@/features/sandbox-agent";
import type { RequestLogger } from "@/features/streaming/logger";
import { forwardChatTurnToSandbox, type TurnRequest } from "./sandbox-proxy";

type SandboxScopeType = "global" | "collection" | "document";

function toSandboxScope(scope: ChatMessagesScope): SandboxScopeType {
	if (scope === "collection") return "collection";
	if (scope === "document") return "document";
	return "global";
}

export interface RunSandboxChatOptions {
	userId: string;
	/** Product-visible thread id for this turn. */
	conversationId: string;
	/** Identifies this single backend execution attempt. */
	runId: string;
	query: string;
	scope: ChatMessagesScope;
	collectionId: string | null;
	summaryId: string | null;
	/** Claude SDK resume state. Null starts a fresh agent session. */
	agentSessionId: string | null;
	onTextDelta: (text: string) => Promise<void>;
	onAgentSessionId: (agentSessionId: string) => Promise<void>;
	onSandboxId: (sandboxId: string) => Promise<void>;
	/** Fired once the in-sandbox daemon is confirmed up, before the turn is forwarded. */
	onDaemonStarted: () => Promise<void>;
	logger: RequestLogger;
}

export type RunSandboxChatResult = { status: "completed" };

/**
 * Run one chat turn through a leased sandbox.
 *
 * The turn leases a warm sandbox for `{userId, conversationId}` (reused across
 * turns) or, on a miss, creates and hydrates a fresh one — all owned by the
 * `SandboxLeaseManager`. The lease is released, not killed, when the turn ends:
 * `release` syncs the durable workspace and keeps the sandbox warm for the next
 * turn, so consecutive turns in a conversation avoid a cold start + re-hydrate.
 *
 * `acquire` throws {@link ConversationBusyError} when a turn for the same
 * conversation is already in flight; that propagates to the controller, which
 * surfaces it as retryable backpressure rather than a run failure. A fresh
 * sandbox that cannot be made usable is torn down inside `acquire`, and a
 * transient create failure is retried there once — so this function neither
 * creates nor kills sandboxes directly.
 */
export async function runSandboxChat(
	deps: AppDeps,
	options: RunSandboxChatOptions,
): Promise<RunSandboxChatResult> {
	const { config, leaseManager } = deps;
	const {
		userId,
		conversationId,
		runId,
		query,
		scope,
		collectionId,
		summaryId,
		agentSessionId,
		onTextDelta,
		onAgentSessionId,
		onSandboxId,
		onDaemonStarted,
		logger,
	} = options;

	logger.info({
		msg: "Sandbox chat run starting",
		userId,
		conversationId,
		runId,
	});

	const lease = await leaseManager.acquire({ userId, conversationId }, logger, {
		agentSessionId,
	});

	// Distinguishes a clean turn (release keeps the sandbox warm) from a failure
	// (release drops the lease + kills the sandbox, so the next turn doesn't
	// reattach a broken one and an abandoned daemon turn is torn down).
	let ok = false;
	try {
		await onSandboxId(lease.sandbox.sandboxId);
		// `acquire` already ensured the daemon (fresh lease) or reattached to it
		// (warm reuse), so the daemon is reachable here.
		await onDaemonStarted();

		const systemPrompt = buildSandboxAgentPrompt({
			scope,
			summaryId,
			collectionId,
			conversationContext: null,
		});

		const requestId = crypto.randomUUID();

		// Two single-audience capability tokens for this turn. They share the same
		// identity/run claims; only `aud` and the document scope differ. The gateway
		// enforces audience per route, so the LLM token cannot read documents and
		// the document token cannot spend on the LLM. The daemon sets the LLM token
		// as the agent's ANTHROPIC_AUTH_TOKEN and the doc token as its MYMEMO_DOC_TOKEN.
		const baseClaims: Omit<LlmTokenClaims, "exp" | "aud"> = {
			userId,
			sandboxId: lease.sandbox.sandboxId,
			requestId,
			conversationId,
			runId,
		};
		const turnRequest: TurnRequest = {
			request_id: requestId,
			user_id: userId,
			conversation_id: conversationId,
			run_id: runId,
			scope_type: toSandboxScope(scope),
			collection_id: collectionId ?? undefined,
			summary_id: summaryId ?? undefined,
			message: query,
			// The lease resolves the resume state to thread in (the explicit option,
			// or the conversation's recorded session); null starts fresh.
			agent_session_id: lease.agentSessionId ?? undefined,
			system_prompt: systemPrompt,
			llm_base_url: config.gatewayPublicUrl,
			doc_gateway_url: config.gatewayPublicUrl,
			// LLM token: no document scope — the LLM proxy ignores it.
			llm_token: mintLlmToken(
				{ ...baseClaims, aud: "llm" },
				config.llmTokenSecret,
			),
			// Document token: carries the signed scope the document routes enforce
			// server-side (the agent cannot widen it).
			doc_token: mintLlmToken(
				{
					...baseClaims,
					aud: "documents",
					scope: toSandboxScope(scope),
					collectionId: collectionId ?? undefined,
					summaryId: summaryId ?? undefined,
				},
				config.llmTokenSecret,
			),
		};

		await forwardChatTurnToSandbox({
			daemonUrl: lease.daemon.url,
			trafficAccessToken: lease.daemon.trafficAccessToken,
			turnRequest,
			onTextDelta,
			// The proxy surfaces the daemon's Claude SDK session id, which we expose
			// as the agent session id.
			onSessionId: onAgentSessionId,
			// Abort the daemon call if the heartbeat finds the lease was lost.
			abortSignal: lease.abortSignal,
		});

		ok = true;
		return { status: "completed" } as const;
	} finally {
		// On success `release` keeps the sandbox warm + persists the pointer; on
		// failure it drops the lease and kills the sandbox. Errors inside `release`
		// are logged, never thrown, so they can't mask the turn's own outcome.
		await leaseManager.release(lease, logger, { ok });
	}
}
