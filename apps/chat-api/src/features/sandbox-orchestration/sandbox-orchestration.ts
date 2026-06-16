import { mintLlmToken } from "@mymemo/llm-token";
import { apiEnv, type ChatMessagesScope } from "@/config/env";
import type { ChatLogger } from "@/features/chat/chat.logger";
import { buildSandboxAgentPrompt } from "@/features/sandbox-agent";
import { SandboxCreationError } from "./errors";
import { forwardChatTurnToSandbox, type TurnRequest } from "./sandbox-proxy";
import { sandboxManager } from "./singleton";

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
	onTextEnd: () => Promise<void>;
	onAgentSessionId: (agentSessionId: string) => Promise<void>;
	onSandboxId: (sandboxId: string) => Promise<void>;
	logger: ChatLogger;
}

export type RunSandboxChatResult = { status: "completed" };

export async function runSandboxChat(
	options: RunSandboxChatOptions,
): Promise<RunSandboxChatResult> {
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
		onTextEnd,
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
		const sandbox = await sandboxManager.createSandbox(userId, logger);

		// Sandboxes are ephemeral — one per turn — so they must be torn down when
		// the turn finishes (success or failure), or they accumulate in E2B. The
		// finally also covers the partial-failure path (created, then daemon
		// startup throws). createSandbox stays outside the try: if it throws there
		// is no sandbox to kill and the outer retry handles it.
		try {
			await onSandboxId(sandbox.sandboxId);

			const daemon = await sandboxManager.ensureSandboxDaemon(
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
				llm_base_url: apiEnv.GATEWAY_PUBLIC_URL,
				doc_gateway_url: apiEnv.GATEWAY_PUBLIC_URL,
				// One per-turn capability token. The gateway's LLM proxy uses
				// {userId,sandboxId,requestId}; its document routes additionally
				// enforce the signed scope. The daemon sets it as both the LLM and
				// the document bearer token on the agent.
				llm_token: mintLlmToken(
					{
						userId,
						sandboxId: sandbox.sandboxId,
						requestId,
						scope: toSandboxScope(scope),
						collectionId: collectionId ?? undefined,
						summaryId: summaryId ?? undefined,
					},
					apiEnv.LLM_TOKEN_SECRET,
				),
			};

			await forwardChatTurnToSandbox({
				daemonUrl: daemon.url,
				daemonAuthToken: daemon.authToken,
				turnRequest,
				onTextDelta,
				onTextEnd,
				// The proxy surfaces the daemon's Claude SDK session id, which we
				// expose as the agent session id.
				onSessionId: onAgentSessionId,
			});

			return { status: "completed" } as const;
		} finally {
			await sandboxManager.killSandbox(userId, sandbox, logger);
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
