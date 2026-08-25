import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import {
	appendAgentQuerySessionEntriesTx,
	deleteAgentQuerySessionTx,
	isMainAgentSessionRef,
	listAgentSessionSubkeysTx,
	listAgentSessionsTx,
	loadAgentSessionEntriesTx,
} from "@mymemo/agent-db/session-store";

export function createAgentQuerySessionStore(
	db: Database,
	conversation: { conversationId: string; conversationEpoch: number },
) {
	let mirroredMainSessionId: string | null = null;
	const ref = (key: SessionKey) => ({
		projectKey: key.projectKey,
		sessionId: key.sessionId,
		subpath: key.subpath,
	});
	return {
		async append(key, entries) {
			await appendAgentQuerySessionEntriesTx(db, {
				...conversation,
				ref: ref(key),
				entries,
			});
			if (entries.length > 0 && isMainAgentSessionRef(key)) {
				mirroredMainSessionId = key.sessionId;
			}
		},
		async load(key) {
			return (await loadAgentSessionEntriesTx(db, {
				conversationId: conversation.conversationId,
				...ref(key),
			})) as SessionStoreEntry[] | null;
		},
		async listSessions() {
			return listAgentSessionsTx(db, {
				conversationId: conversation.conversationId,
			});
		},
		async listSubkeys(key) {
			return listAgentSessionSubkeysTx(db, {
				conversationId: conversation.conversationId,
				sessionId: key.sessionId,
			});
		},
		async delete(key) {
			await deleteAgentQuerySessionTx(db, {
				...conversation,
				ref: { sessionId: key.sessionId, subpath: key.subpath },
			});
			if (
				isMainAgentSessionRef(key) &&
				mirroredMainSessionId === key.sessionId
			) {
				mirroredMainSessionId = null;
			}
		},
		mirroredMainSessionId() {
			return mirroredMainSessionId;
		},
	} satisfies SessionStore & { mirroredMainSessionId(): string | null };
}

export type AgentQuerySessionStore = ReturnType<
	typeof createAgentQuerySessionStore
>;
