/**
 * Conversation continuity for the split runtime (ADR-0005, Task 7.3): the Claude
 * Agent SDK runs in stateless AgentCore Runtime sessions, so its local transcript
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
import type { RunWriteOwner } from "@mymemo/agent-db/run-store";
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
	/** The latest main transcript that still exists after a successful non-empty
	 * mirror during the current Run, or `null` when none qualifies. */
	mirroredMainSessionId(): string | null;
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
 * A Postgres-backed {@link ConversationSessionStore} bound to one claimed Run.
 * It stamps every mirrored entry with the Run's conversation id and fences SDK
 * append/delete mutations with the Conversation's live Ownership fence. A
 * later turn on any worker can therefore read the same transcript, while stale
 * Claims cannot mutate it. The adapter also records this Run's latest
 * successful non-empty main-session mirror as continuity evidence.
 *
 * `projectKey` from the SDK key is retained for fidelity but is not a lookup
 * key; the bound conversation id is the stable transcript identity.
 */
export function createConversationSessionStore(
	db: Database,
	binding: {
		owner: RunWriteOwner;
		logger: WorkerLogger;
	},
): ConversationSessionStore {
	const { owner, logger } = binding;
	const { conversationId, runId } = owner;
	let latestMirroredMainSessionId: string | null = null;
	const ref = (key: SessionKey) => ({
		projectKey: key.projectKey,
		sessionId: key.sessionId,
		subpath: key.subpath,
	});
	return {
		async append(key, entries) {
			try {
				await appendAgentSessionEntriesTx(db, {
					owner,
					ref: ref(key),
					entries,
				});
				if (entries.length > 0 && isMainAgentSessionRef(key)) {
					latestMirroredMainSessionId = key.sessionId;
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
			return (await loadAgentSessionEntriesTx(db, {
				conversationId,
				...ref(key),
			})) as SessionStoreEntry[] | null;
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
			await deleteAgentSessionTx(db, {
				owner,
				ref: {
					sessionId: key.sessionId,
					subpath: key.subpath,
				},
			});
			if (
				isMainAgentSessionRef(key) &&
				latestMirroredMainSessionId === key.sessionId
			) {
				latestMirroredMainSessionId = null;
			}
		},
		mirroredMainSessionId() {
			return latestMirroredMainSessionId;
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
	owner: RunWriteOwner;
	runtime: ConversationRuntimeRecord | null;
	logger: WorkerLogger;
}): AgentSessionQueryConfig {
	const { db, owner, runtime, logger } = input;
	const config: AgentSessionQueryConfig = {
		sessionStore: createConversationSessionStore(db, { owner, logger }),
		cwd: conversationWorkingDirectory(owner.conversationId),
	};
	const resume = runtime?.agentSessionId ?? undefined;
	if (resume) config.resume = resume;
	return config;
}
