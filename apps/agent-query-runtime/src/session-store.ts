import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import {
	appendDirectResponseAgentSessionEntriesTx,
	type DirectResponseOwner,
	deleteDirectResponseAgentSessionTx,
	listDirectResponseAgentSessionSubkeysTx,
	listDirectResponseAgentSessionsTx,
	loadDirectResponseAgentSessionEntriesTx,
} from "@mymemo/agent-db/direct-response";

export interface DirectResponseSessionStore extends SessionStore {
	mirroredMainSessionId(): string | null;
}

function isMainSession(key: Pick<SessionKey, "subpath">): boolean {
	return (key.subpath ?? "") === "";
}

export function createDirectResponseSessionStore(
	db: Database,
	owner: DirectResponseOwner,
): DirectResponseSessionStore {
	let mirroredMainSessionId: string | null = null;
	const ref = (key: SessionKey) => ({
		projectKey: key.projectKey,
		sessionId: key.sessionId,
		subpath: key.subpath,
	});
	return {
		async append(key, entries) {
			await appendDirectResponseAgentSessionEntriesTx(db, {
				owner,
				ref: ref(key),
				entries,
			});
			if (entries.length > 0 && isMainSession(key)) {
				mirroredMainSessionId = key.sessionId;
			}
		},
		async load(key) {
			return (await loadDirectResponseAgentSessionEntriesTx(db, {
				conversationId: owner.conversationId,
				...ref(key),
			})) as SessionStoreEntry[] | null;
		},
		async listSessions() {
			return await listDirectResponseAgentSessionsTx(db, owner.conversationId);
		},
		async listSubkeys(key) {
			return await listDirectResponseAgentSessionSubkeysTx(db, {
				conversationId: owner.conversationId,
				sessionId: key.sessionId,
			});
		},
		async delete(key) {
			await deleteDirectResponseAgentSessionTx(db, {
				owner,
				ref: { sessionId: key.sessionId, subpath: key.subpath },
			});
			if (isMainSession(key) && mirroredMainSessionId === key.sessionId) {
				mirroredMainSessionId = null;
			}
		},
		mirroredMainSessionId() {
			return mirroredMainSessionId;
		},
	};
}
