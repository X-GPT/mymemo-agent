import type { Db } from "./db";
import type { FrozenConversationScope } from "./scope";

/**
 * Identifies one run's document access for the audit ledger. Narrower than the
 * sandbox `RunBinding` on purpose: document access happens in the trusted
 * worker, so there is no sandbox in the picture.
 */
export interface DocumentAccessBinding {
	userId: string;
	conversationId: string;
	runId: string;
}

/** The collection/summary id the scope was policy-checked against, if any. */
function scopeId(scope: FrozenConversationScope): string | null {
	switch (scope.type) {
		case "general":
			return null;
		case "collection":
			return scope.collectionId;
		case "document":
			return scope.summaryId;
	}
}

/**
 * Append one row to the `document_access_events` ledger (owned by chat-api's
 * Drizzle migrations). `query` is null for direct fetch/load access;
 * `documentIds` is empty for a no-hit search. Full document content is never
 * written here.
 */
export async function recordDocumentAccess(
	agentDb: Db,
	entry: {
		binding: DocumentAccessBinding;
		scope: FrozenConversationScope;
		query: string | null;
		documentIds: string[];
	},
): Promise<void> {
	await agentDb.query(
		`INSERT INTO document_access_events
		   (run_id, conversation_id, user_id, scope_type, scope_id, query, document_ids)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			entry.binding.runId,
			entry.binding.conversationId,
			entry.binding.userId,
			entry.scope.type,
			scopeId(entry.scope),
			entry.query,
			entry.documentIds,
		],
	);
}
