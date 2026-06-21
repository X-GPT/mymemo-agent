import { type LlmTokenClaims, mintLlmToken } from "@mymemo/llm-token";
import type { ChatMessagesScope } from "@/config/env";
import type { AppDeps } from "@/deps";
import type { ChatLogger } from "@/features/chat/chat.logger";
import { buildSandboxAgentPrompt } from "@/features/sandbox-agent";
import { SandboxCreationError } from "./errors";
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
	logger: ChatLogger;
}

export type RunSandboxChatResult = { status: "completed" };

export async function runSandboxChat(
	deps: AppDeps,
	options: RunSandboxChatOptions,
): Promise<RunSandboxChatResult> {
	const { config, sandboxProvider, workspaceStore } = deps;
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
		logger,
	} = options;

	logger.info({
		msg: "Sandbox chat run starting",
		userId,
		conversationId,
		runId,
	});

	const attempt = async () => {
		// Prepare the durable workspace before the run. Done before leasing a
		// sandbox so the durable layout and working-set manifest exist regardless
		// of whether the sandbox comes up.
		await workspaceStore.hydrateConversationWorkspace({
			userId,
			conversationId,
		});

		const sandbox = await sandboxProvider.createSandbox(userId, logger);

		// Sandboxes are ephemeral — one per turn — so they must be torn down when
		// the turn finishes (success or failure), or they accumulate in E2B. The
		// finally also covers the partial-failure path (created, then daemon
		// startup throws). createSandbox stays outside the try: if it throws there
		// is no sandbox to kill and the outer retry handles it.
		try {
			await onSandboxId(sandbox.sandboxId);

			const daemon = await sandboxProvider.ensureSandboxDaemon(
				userId,
				sandbox,
				logger,
			);

			const systemPrompt = buildSandboxAgentPrompt({
				scope,
				summaryId,
				collectionId,
				conversationContext: null,
			});

			const requestId = crypto.randomUUID();

			// Two single-audience capability tokens for this turn. They share the
			// same identity/run claims; only `aud` and the document scope differ.
			// The gateway enforces audience per route, so the LLM token cannot read
			// documents and the document token cannot spend on the LLM. The daemon
			// sets the LLM token as the agent's ANTHROPIC_AUTH_TOKEN and the doc
			// token as its MYMEMO_DOC_TOKEN.
			const baseClaims: Omit<LlmTokenClaims, "exp" | "aud"> = {
				userId,
				sandboxId: sandbox.sandboxId,
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
				agent_session_id: agentSessionId ?? undefined,
				system_prompt: systemPrompt,
				llm_base_url: config.gatewayPublicUrl,
				doc_gateway_url: config.gatewayPublicUrl,
				// LLM token: no document scope — the LLM proxy ignores it.
				llm_token: mintLlmToken(
					{ ...baseClaims, aud: "llm" },
					config.llmTokenSecret,
				),
				// Document token: carries the signed scope the document routes
				// enforce server-side (the agent cannot widen it).
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
				daemonUrl: daemon.url,
				daemonAuthToken: daemon.authToken,
				turnRequest,
				onTextDelta,
				// The proxy surfaces the daemon's Claude SDK session id, which we
				// expose as the agent session id.
				onSessionId: onAgentSessionId,
			});

			return { status: "completed" } as const;
		} finally {
			// A sandbox was leased, so persist the durable workspace whether the
			// turn succeeded, failed, or was canceled. A sync failure must not mask
			// the turn's own outcome, and the sandbox must still be torn down.
			try {
				await workspaceStore.syncConversationWorkspace({
					userId,
					conversationId,
				});
			} catch (syncErr) {
				logger.error({
					msg: "Workspace sync failed",
					userId,
					conversationId,
					runId,
					error: syncErr instanceof Error ? syncErr.message : String(syncErr),
				});
			}
			await sandboxProvider.killSandbox(userId, sandbox, logger);
		}
	};

	try {
		return await attempt();
	} catch (err) {
		if (!(err instanceof SandboxCreationError)) {
			throw err;
		}

		logger.error({
			msg: "Sandbox creation failed, retrying",
			userId,
			conversationId,
			runId,
			error: err.message,
		});

		try {
			return await attempt();
		} catch (retryErr) {
			logger.error({
				msg: "Sandbox creation retry also failed",
				userId,
				conversationId,
				runId,
				error: retryErr instanceof Error ? retryErr.message : String(retryErr),
			});
			throw retryErr;
		}
	}
}
