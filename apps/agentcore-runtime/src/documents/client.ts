import type { RuntimeLogger } from "../logger";
import {
	type DocumentAccessBinding,
	type DocumentAccessOperation,
	recordDocumentAccess,
} from "./audit";
import { createAgentDb, createKbDb, type Db } from "./db";
import { DocumentQueryError, DocumentScopeError } from "./errors";
import {
	type DocumentListCursor,
	type DocumentListPage,
	documentInCollection,
	type FetchedDocument,
	fetchDocument,
	listDocuments,
	resolveDocumentId,
	type SearchHit,
	searchPassages,
} from "./kb-queries";
import type { FrozenConversationScope } from "./scope";

/**
 * The scoped document query client (plan Task 6.1): the single trusted path
 * from the Runtime's agent loop to the read-only KB. Applies the Conversation's
 * frozen scope server-side before any query and audits every access to
 * `document_access_events`. Model-facing tools (ListDocuments,
 * SearchDocuments, and LoadDocuments) call these named methods only — no Db
 * handle ever reaches tool code.
 */
export interface ScopedDocumentQueryClient {
	listDocuments(input: {
		binding: DocumentAccessBinding;
		scope: FrozenConversationScope;
		limit: number;
		after: DocumentListCursor | null;
	}): Promise<DocumentListPage>;

	searchDocuments(input: {
		binding: DocumentAccessBinding;
		scope: FrozenConversationScope;
		query: string;
		maxResults?: number;
	}): Promise<{ passages: SearchHit[] }>;

	/**
	 * Fetch one document's (capped) content after the frozen scope admits it.
	 * Unknown and out-of-scope ids fail with one uniform `DocumentScopeError`
	 * so callers can never probe document existence across scopes.
	 */
	fetchDocumentInScope(input: {
		binding: DocumentAccessBinding;
		scope: FrozenConversationScope;
		documentId: string;
	}): Promise<FetchedDocument>;
}

/** The two credentials document search cannot run without. */
export interface DocumentSearchConfig {
	kbDatabaseUrl: string;
	agentDatabaseUrl: string;
}

interface ClientOptions {
	kbDb: Db;
	agentDb: Db;
	logger: RuntimeLogger;
}

const DEFAULT_SEARCH_LIMIT = 8;
// Hard backstop on rows per search, whatever the tool layer asks for.
const MAX_SEARCH_LIMIT = 20;

/** Clamp a caller-supplied result limit into [1, MAX_SEARCH_LIMIT]. */
function clampSearchLimit(maxResults: number | undefined): number {
	if (maxResults === undefined) return DEFAULT_SEARCH_LIMIT;
	return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(maxResults)));
}
// Matches the production read_document clip the gateway used, so a large
// document cannot dump hundreds of KB into the agent loop.
const MAX_DOCUMENT_CHARS = 50_000;

/** One uniform rejection for unknown AND out-of-scope ids — no existence leak. */
function documentNotAvailable(): DocumentScopeError {
	return new DocumentScopeError(
		"document is not available in this conversation's scope",
	);
}

/** Distinct document ids of the hits, in first-hit order, for the audit row. */
function hitDocumentIds(hits: SearchHit[]): string[] {
	return [...new Set(hits.map((h) => h.documentId))];
}

/** Seam-injected factory; unit tests drive the client through fake Dbs. */
export function createScopedDocumentQueryClient(
	options: ClientOptions,
): ScopedDocumentQueryClient {
	const { kbDb, agentDb, logger } = options;

	/**
	 * Reduce an infrastructure failure (KB or audit ledger) to a fixed,
	 * model-safe message. The underlying cause — which may carry SQL or a
	 * connection string — goes only to the Runtime log. Scope rejections are
	 * already model-safe and pass through untouched.
	 */
	function bounded(
		failureMessage: string,
		error: unknown,
		binding: DocumentAccessBinding,
	): Error {
		if (error instanceof DocumentScopeError) return error;
		logger.error({
			message: failureMessage,
			runId: binding.runId,
			conversationId: binding.conversationId,
			userId: binding.userId,
			cause: error instanceof Error ? error.message : String(error),
		});
		return new DocumentQueryError(failureMessage);
	}

	/**
	 * Resolve a document-scope conversation's frozen summaryId to the KB
	 * document id it is allowed to touch. The member_code pin lives here and
	 * only here, so search and fetch can never drift apart on how the scope's
	 * user boundary is applied.
	 */
	function resolveFrozenDocumentId(
		scope: Extract<FrozenConversationScope, { type: "document" }>,
		binding: DocumentAccessBinding,
	): Promise<string | null> {
		return resolveDocumentId(kbDb, {
			summaryId: scope.summaryId,
			memberCode: binding.userId,
		});
	}

	async function audit(
		binding: DocumentAccessBinding,
		scope: FrozenConversationScope,
		operation: DocumentAccessOperation,
		query: string | null,
		documentIds: string[],
		resultCount: number,
	): Promise<void> {
		await recordDocumentAccess(agentDb, {
			binding,
			scope,
			operation,
			query,
			documentIds,
			resultCount,
		});
	}

	return {
		async listDocuments({ binding, scope, limit, after }) {
			try {
				let documentIds: string[] | null = null;
				let collectionId: string | null = null;
				if (scope.type === "document") {
					const documentId = await resolveFrozenDocumentId(scope, binding);
					if (!documentId) {
						const empty = { total: 0, documents: [], next: null };
						await audit(binding, scope, "list", null, [], 0);
						return empty;
					}
					documentIds = [documentId];
				} else if (scope.type === "collection") {
					collectionId = scope.collectionId;
				}

				const page = await listDocuments(kbDb, {
					workspaceId: binding.userId,
					documentIds,
					collectionId,
					limit,
					after,
				});
				await audit(
					binding,
					scope,
					"list",
					null,
					page.documents.map((document) => document.documentId),
					page.total,
				);
				return page;
			} catch (error) {
				throw bounded("document list failed", error, binding);
			}
		},

		async searchDocuments({ binding, scope, query, maxResults }) {
			try {
				// Derive the query narrowing from the frozen scope ONLY — the input
				// carries no filter a caller could widen.
				let documentIds: string[] | null = null;
				let collectionId: string | null = null;
				if (scope.type === "document") {
					const docId = await resolveFrozenDocumentId(scope, binding);
					// Unresolvable document scope fails closed: no passage query runs.
					if (!docId) {
						await audit(binding, scope, "search", query, [], 0);
						return { passages: [] };
					}
					documentIds = [docId];
				} else if (scope.type === "collection") {
					collectionId = scope.collectionId;
				}

				const passages = await searchPassages(kbDb, {
					workspaceId: binding.userId,
					query,
					documentIds,
					collectionId,
					limit: clampSearchLimit(maxResults),
				});
				await audit(
					binding,
					scope,
					"search",
					query,
					hitDocumentIds(passages),
					passages.length,
				);
				return { passages };
			} catch (error) {
				throw bounded("document search failed", error, binding);
			}
		},

		async fetchDocumentInScope({ binding, scope, documentId }) {
			try {
				// Scope guard first — an out-of-scope id is rejected before any
				// document row is read or audited.
				if (scope.type === "document") {
					const docId = await resolveFrozenDocumentId(scope, binding);
					if (!docId || documentId !== docId) throw documentNotAvailable();
				} else if (scope.type === "collection") {
					const inCollection = await documentInCollection(kbDb, {
						collectionId: scope.collectionId,
						workspaceId: binding.userId,
						documentId,
					});
					if (!inCollection) throw documentNotAvailable();
				}

				const doc = await fetchDocument(kbDb, {
					workspaceId: binding.userId,
					documentId,
					maxChars: MAX_DOCUMENT_CHARS,
				});
				if (!doc) throw documentNotAvailable();
				await audit(binding, scope, "load", null, [documentId], 1);
				return doc;
			} catch (error) {
				throw bounded("document fetch failed", error, binding);
			}
		},
	};
}

/**
 * Composition-root factory: refuses to start document search unless both the
 * KB credential and the agent (audit-ledger) credential are present.
 */
export function createDocumentSearch(
	config: DocumentSearchConfig,
	logger: RuntimeLogger,
): ScopedDocumentQueryClient {
	return createScopedDocumentQueryClient({
		kbDb: createKbDb(config.kbDatabaseUrl),
		agentDb: createAgentDb(config.agentDatabaseUrl),
		logger,
	});
}
