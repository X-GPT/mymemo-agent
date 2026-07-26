/**
 * Conversation continuity for the split runtime (ADR-0005, Task 7.3): the Claude
 * Agent SDK runs in stateless Fargate workers, so its worker-local transcript
 * files cannot carry a conversation's model-side memory across turns. This
 * module restores continuity by mirroring transcripts to the writable agent
 * Postgres through the SDK's `SessionStore` seam, and pointing each turn's query
 * at the previous turn's session.
 */

import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import type { RunMutationOwner } from "@mymemo/agent-db/run-ownership";
import type { ConversationRuntimeRecord } from "@mymemo/agent-db/runtime-store";
import {
	appendAgentSessionEntriesTx,
	deleteAgentSessionTx,
	isMainAgentSessionRef,
	listAgentSessionSubkeysTx,
	listAgentSessionsTx,
	loadAgentSessionEntriesTx,
} from "@mymemo/agent-db/session-store";
import type { WorkerLogger } from "../logger";

/** Query-level projection of the bound adapter's per-Run mirror evidence. */
export interface SessionMirrorEvidence {
	/** True only while the named main transcript still exists after a successful
	 * non-empty mirror during the current Run. */
	hasMirroredMainSession(sessionId: string): boolean;
}

export interface ConversationSessionStore
	extends SessionStore,
		SessionMirrorEvidence {}

/**
 * The deterministic, conversation-stable working directory the worker runs every
 * query in. The SDK derives a session's `projectKey` from the sanitized cwd, and
 * the store must see the SAME projectKey for a conversation on every worker and
 * turn or a later turn cannot find the earlier transcript. A path derived purely
 * from the (path-safe, server-generated) conversation id guarantees that.
 */
export function conversationWorkingDirectory(conversationId: string): string {
	return `/workspace/conversations/${conversationId}`;
}

/**
 * A Postgres-backed {@link SessionStore} bound to one conversation. Built per run
 * (a run belongs to exactly one conversation), it stamps every mirrored entry
 * with the conversation id — so a later turn on any worker reads back the same
 * transcript, and conversation-scoped deletion is exact — and delegates the SQL
 * to the shared agent-db helpers. `projectKey` from the SDK key is recorded but
 * not used as a lookup key; the bound conversation id is the stable identity.
 */
export function createConversationSessionStore(
	db: Database,
	binding: {
		conversationId: string;
		runId: string;
		workerId: string;
		logger: WorkerLogger;
	},
): ConversationSessionStore {
	const { conversationId, runId, workerId, logger } = binding;
	const owner: RunMutationOwner = {
		conversationId,
		runId,
		workerId,
	};
	const mirroredMainSessionIds = new Set<string>();
	const ref = (key: SessionKey) => ({
		conversationId,
		projectKey: key.projectKey,
		sessionId: key.sessionId,
		subpath: key.subpath,
	});
	return {
		async append(key, entries) {
			try {
				await appendAgentSessionEntriesTx(db, ref(key), entries, owner);
				if (entries.length > 0 && isMainAgentSessionRef(key)) {
					mirroredMainSessionIds.add(key.sessionId);
				}
			} catch (error) {
				logger.error({
					message: "agent session mirror append failed",
					runId,
					conversationId,
					// Error identity is useful to operators without exposing the
					// transcript-bearing database error message.
					errorType: error instanceof Error ? error.name : typeof error,
				});
				throw error;
			}
		},
		async load(key) {
			// The store round-trips exactly the SessionStoreEntry blobs the SDK
			// appended; the agent-db layer types them as opaque JSON (no required
			// `type`), so this narrowing cast restores the SDK's view. Deep-equal —
			// not byte-equal — is all the SDK requires (jsonb may reorder keys).
			return (await loadAgentSessionEntriesTx(db, ref(key))) as
				| SessionStoreEntry[]
				| null;
		},
		async listSessions(_projectKey) {
			// Conversation-bound: the SDK-supplied projectKey names this same
			// conversation, so we list by the bound id.
			return await listAgentSessionsTx(db, { conversationId });
		},
		async listSubkeys(key) {
			return await listAgentSessionSubkeysTx(db, {
				conversationId,
				sessionId: key.sessionId,
			});
		},
		async delete(key) {
			await deleteAgentSessionTx(
				db,
				{
					conversationId,
					sessionId: key.sessionId,
					subpath: key.subpath,
				},
				owner,
			);
			if (isMainAgentSessionRef(key)) {
				mirroredMainSessionIds.delete(key.sessionId);
			}
		},
		hasMirroredMainSession(sessionId) {
			return mirroredMainSessionIds.has(sessionId);
		},
	};
}

/**
 * The session-related slice of a run's query options (ADR-0005): the store to
 * mirror through, the conversation-stable cwd that stabilizes `projectKey`, and
 * the resume pointer — present only when the conversation has a stored session,
 * so a first turn starts fresh and a later turn resumes the prior transcript.
 */
export interface AgentSessionQueryConfig {
	sessionStore: ConversationSessionStore;
	cwd: string;
	resume?: string;
}

/**
 * Build a run's session query config from its conversation's runtime row. A
 * `null` runtime, or a runtime whose pointer never advanced, yields no `resume`
 * (a fresh session); a runtime with an `agentSessionId` resumes it through the
 * store.
 */
export function buildAgentSessionQueryConfig(input: {
	db: Database;
	conversationId: string;
	runtime: ConversationRuntimeRecord | null;
	runId: string;
	workerId: string;
	logger: WorkerLogger;
}): AgentSessionQueryConfig {
	const { db, conversationId, runtime, runId, workerId, logger } = input;
	const config: AgentSessionQueryConfig = {
		sessionStore: createConversationSessionStore(db, {
			conversationId,
			runId,
			workerId,
			logger,
		}),
		cwd: conversationWorkingDirectory(conversationId),
	};
	const resume = runtime?.agentSessionId ?? undefined;
	if (resume) config.resume = resume;
	return config;
}
