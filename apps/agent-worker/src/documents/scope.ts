import { DocumentScopeError } from "./errors";

/**
 * A conversation's frozen document scope, resolved once at conversation
 * creation and never widened afterwards (see the `conversations` table). The
 * discriminated union makes an out-of-scope filter unrepresentable in client
 * code: search/fetch constraints are derived from this value only, never from
 * caller-supplied filters.
 */
export type FrozenConversationScope =
	| { type: "general" }
	| { type: "collection"; collectionId: string }
	| { type: "document"; summaryId: string };

/**
 * Parse a persisted conversation-scope row into the typed scope, failing
 * closed: a scope value outside the legal set, or a scoped row missing its id,
 * is rejected rather than widened to `general`. The `scope` column is the
 * authority (the DB check constraint defends its legal values); the ids are
 * read from the column that scope requires.
 */
export function parseFrozenScope(row: {
	scope: string;
	collectionId: string | null;
	summaryId: string | null;
}): FrozenConversationScope {
	switch (row.scope) {
		case "general":
			return { type: "general" };
		case "collection":
			if (!row.collectionId) {
				throw new DocumentScopeError(
					"conversation scope is invalid: collection scope without a collection id",
				);
			}
			return { type: "collection", collectionId: row.collectionId };
		case "document":
			if (!row.summaryId) {
				throw new DocumentScopeError(
					"conversation scope is invalid: document scope without a document id",
				);
			}
			return { type: "document", summaryId: row.summaryId };
		default:
			throw new DocumentScopeError(
				"conversation scope is invalid: unknown scope type",
			);
	}
}
