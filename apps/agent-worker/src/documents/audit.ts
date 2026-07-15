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

export type DocumentAccessOperation = "search" | "list" | "load";

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
 * Drizzle migrations). `query` is present only for search; `documentIds` is
 * empty for an empty page or no-hit search. Full document content is never
 * written here. `resultCount` records passages for search, the exact scoped
 * total for list, and one for a successful load.
 */
export async function recordDocumentAccess(
	agentDb: Db,
	entry: {
		binding: DocumentAccessBinding;
		scope: FrozenConversationScope;
		operation: DocumentAccessOperation;
		query: string | null;
		documentIds: string[];
		resultCount: number;
	},
): Promise<void> {
	await agentDb.query(
		`INSERT INTO document_access_events
		   (run_id, conversation_id, user_id, operation, scope_type, scope_id,
		    query, document_ids, result_count)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			entry.binding.runId,
			entry.binding.conversationId,
			entry.binding.userId,
			entry.operation,
			entry.scope.type,
			scopeId(entry.scope),
			entry.query,
			entry.documentIds,
			entry.resultCount,
		],
	);
}
