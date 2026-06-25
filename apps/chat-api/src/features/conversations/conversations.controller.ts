import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationScope,
	ConversationStore,
} from "@/features/conversation-store";
import { createRun } from "@/features/run-state";
import {
	ConversationBusyError,
	runSandboxChat,
} from "@/features/sandbox-orchestration";
import type { RequestLogger } from "@/features/streaming/logger";
import { createSseRunEventSink } from "@/features/streaming/run-event-sink";
import type { MymemoEventSender } from "@/features/streaming/sse-sender";
import type { InternalIdentity } from "./conversations.schema";

/**
 * Create a conversation: resolve its document scope from the supplied ids once,
 * freeze it onto a new record, and return the generated id + scope. The scope is
 * never re-derived after this — every turn reads it back from the store.
 */
export async function createConversation(
	store: ConversationStore,
	identity: InternalIdentity,
	body: { collectionId?: string | null; summaryId?: string | null },
): Promise<{ conversationId: string; scope: ConversationScope }> {
	const conversationId = crypto.randomUUID();
	const collectionId = body.collectionId?.trim() || null;
	const summaryId = body.summaryId?.trim() || null;

	let scope: ConversationScope = "general";
	if (summaryId) {
		scope = "document";
	} else if (collectionId) {
		scope = "collection";
	}

	await store.create({
		userId: identity.memberCode,
		conversationId,
		scope,
		collectionId,
		summaryId,
	});
	return { conversationId, scope };
}

/**
 * Run one `user.message` turn against an existing conversation. Scope comes from
 * the frozen `conversation` record (not the request), so the client cannot widen
 * it. The client-visible SSE stream is a projection of the run's recorded
 * events: each event is persisted, then mapped to its frame(s).
 */
export async function runConversationTurn(
	deps: AppDeps,
	params: { conversation: ConversationRecord; message: string },
	mymemoEventSender: MymemoEventSender,
	logger: RequestLogger,
) {
	const { conversation, message } = params;
	const { userId, conversationId, scope, collectionId, summaryId } =
		conversation;

	// `runId` identifies this single backend execution attempt.
	const runId = crypto.randomUUID();

	const run = await createRun({
		sink: createSseRunEventSink(deps.workspaceStore, mymemoEventSender, logger),
		ref: { userId, runId },
		conversationId,
	});
	// `createRun` recorded `run_started`, from which the client's first frames —
	// `conversation_id` and `run_id` — were derived.

	try {
		await runSandboxChat(deps, {
			userId,
			conversationId,
			runId,
			query: message,
			scope,
			collectionId,
			summaryId,
			// Conversation continuity via `agentSessionId` is wired in a later
			// milestone; a fresh agent session is started each turn for now.
			agentSessionId: null,
			onSandboxId: (sandboxId) => run.recordSandboxLeased(sandboxId),
			onDaemonStarted: () => run.recordDaemonStarted(),
			onAgentSessionId: (agentSessionId) =>
				run.recordAgentEvent({ type: "session_id", sessionId: agentSessionId }),
			onTextDelta: (text) => run.recordAgentEvent({ type: "text_delta", text }),
			logger,
		});
		await run.markRunCompleted();
	} catch (err) {
		if (err instanceof ConversationBusyError) {
			logger.warn({ message: "Sandbox chat run rejected: conversation busy" });
			await run.markRunFailed(
				new Error(
					"Sandbox is busy processing another request. Please try again shortly.",
				),
			);
		} else {
			logger.error({ message: "Sandbox chat run failed", error: err });
			await run.markRunFailed(err);
		}
	}
}
