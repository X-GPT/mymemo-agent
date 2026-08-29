import { Pool } from "pg";
import type { Logger } from "pino";
import type { ConversationRecord } from "@/features/conversation-store/conversation-store";
import type { DocumentAccessLog } from "./document-access-log";

/**
 * The chat path's scoped access to the read-only KB (ADR-0033 stage 2). A
 * fresh, smaller copy of the Runtime's `documents/` module: same SQL, same
 * scope rules, same audit row, bound once per Harness turn instead of per
 * call. Drift between the two is accepted; a boundary fix lands twice.
 */

/** Identifies one Harness turn's document access for the audit ledger. */
export interface HarnessToolBinding {
	userId: string;
	conversationId: string;
	turnId: string;
}

export type FrozenScope =
	| { type: "general" }
	| { type: "collection"; collectionId: string }
	| { type: "document"; summaryId: string };

/** Fails closed: a scoped row missing its id is rejected, never widened. */
export function parseFrozenScope(
	row: Pick<ConversationRecord, "scope" | "collectionId" | "summaryId">,
): FrozenScope {
	switch (row.scope) {
		case "general":
			return { type: "general" };
		case "collection":
			if (!row.collectionId) {
				throw new Error("conversation scope is invalid: collection without id");
			}
			return { type: "collection", collectionId: row.collectionId };
		case "document":
			if (!row.summaryId) {
				throw new Error("conversation scope is invalid: document without id");
			}
			return { type: "document", summaryId: row.summaryId };
	}
}

/** Parameterized-SQL seam so scope filters are unit-tested without Postgres. */
export interface KbDb {
	query<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<T[]>;
}

/** Read-only `mymemo_kb` pool; a runaway query is cut server-side. */
export function createKbDb(kbDatabaseUrl: string): KbDb {
	const pool = new Pool({
		connectionString: kbDatabaseUrl,
		max: 4,
		statement_timeout: 5_000,
		query_timeout: 10_000,
	});
	return {
		query: async <T>(text: string, params: unknown[] = []) =>
			(await pool.query(text, params)).rows as T[],
	};
}

/**
 * Model-safe by construction: the message is a fixed string chosen here, never
 * driver text, SQL, or a connection string (those go to the log).
 */
export class DocumentAccessError extends Error {}

const OUT_OF_SCOPE = "document is not available in this conversation's scope";
// Matches the Run path's server-side clip so one document cannot dump
// hundreds of KB into the turn.
const MAX_DOCUMENT_CHARS = 50_000;

export interface DocumentListCursor {
	createdAt: string;
	sourceAssetId: string;
}

export interface ListedDocument {
	documentId: string;
	title: string;
	sourceType: string;
	language: string | null;
	createdAt: string;
}

export interface DocumentListPage {
	total: number;
	documents: ListedDocument[];
	next: DocumentListCursor | null;
}

export interface SearchHit {
	passageId: string;
	documentId: string;
	title: string;
	snippet: string;
}

export interface FetchedDocument {
	documentId: string;
	title: string;
	content: string;
	/** True when the stored document is longer than the excerpt cap. */
	truncated: boolean;
}

export interface ScopedDocumentClient {
	list(input: {
		limit: number;
		after: DocumentListCursor | null;
	}): Promise<DocumentListPage>;
	search(input: { query: string; maxResults: number }): Promise<SearchHit[]>;
	/** Unknown and out-of-scope ids fail with one uniform message. */
	fetch(documentId: string): Promise<FetchedDocument>;
}

export type HarnessToolLogger = Pick<Logger, "info" | "error">;

/**
 * Scope mapping (the platform's compat layer): workspace_id = the user's
 * member_code; summaryId = content_asset.compat_int_id → kb_document_id;
 * collectionId = content_collection.compat_str_id → compat_int_id →
 * passage_collection.collection_id.
 */
const CURRENT_DOCUMENTS = `WITH current_documents AS (
	SELECT DISTINCT ON (d.source_asset_id)
	       d.id AS "documentId",
	       d.source_asset_id AS "sourceAssetId",
	       d.title,
	       d.source_type AS "sourceType",
	       d.language,
	       sa.created_at AS "createdAt"
	  FROM document d
	  JOIN source_asset sa ON sa.id = d.source_asset_id
	 WHERE d.workspace_id = $1
	   AND d.status = 'active'
	   AND sa.workspace_id = $1
	   AND sa.status = 'ready'
	 ORDER BY d.source_asset_id, d.version DESC, d.id DESC
)`;

async function listDocuments(
	db: KbDb,
	opts: {
		workspaceId: string;
		documentIds: string[] | null;
		collectionId: string | null;
		limit: number;
		after: DocumentListCursor | null;
	},
): Promise<DocumentListPage> {
	const params: unknown[] = [opts.workspaceId];
	let scopeFilter = "";
	if (opts.collectionId) {
		params.push(opts.collectionId);
		scopeFilter += ` AND EXISTS (
			SELECT 1
			  FROM passage p
			  JOIN passage_collection pc ON pc.passage_id = p.id
			  JOIN content_collection c ON c.compat_int_id::text = pc.collection_id
			 WHERE p.document_id = cd."documentId"
			   AND p.workspace_id = $1
			   AND p.status = 'active'
			   AND c.compat_str_id = $${params.length}
		)`;
	}
	if (opts.documentIds) {
		const slots = opts.documentIds
			.map((_, index) => `$${params.length + index + 1}`)
			.join(", ");
		params.push(...opts.documentIds);
		scopeFilter += ` AND cd."documentId" IN (${slots})`;
	}
	let cursorFilter = "";
	if (opts.after) {
		params.push(opts.after.createdAt, opts.after.sourceAssetId);
		cursorFilter = `WHERE (sd."createdAt", sd."sourceAssetId") <
			($${params.length - 1}::timestamptz, $${params.length})`;
	}
	params.push(opts.limit + 1);
	const [row] = await db.query<{
		total: number;
		documents: (ListedDocument & { sourceAssetId: string })[];
	}>(
		`${CURRENT_DOCUMENTS}, scoped_documents AS (
			SELECT cd.*
			  FROM current_documents cd
			 WHERE TRUE${scopeFilter}
		), page AS (
			SELECT sd.*
			  FROM scoped_documents sd
			  ${cursorFilter}
			 ORDER BY sd."createdAt" DESC, sd."sourceAssetId" DESC
			 LIMIT $${params.length}
		)
		SELECT (SELECT count(*)::integer FROM scoped_documents) AS total,
		       COALESCE(
			       jsonb_agg(
				       jsonb_build_object(
					       'documentId', page."documentId",
					       'sourceAssetId', page."sourceAssetId",
					       'title', page.title,
					       'sourceType', page."sourceType",
					       'language', page.language,
					       'createdAt', page."createdAt"
				       ) ORDER BY page."createdAt" DESC, page."sourceAssetId" DESC
			       ) FILTER (WHERE page."documentId" IS NOT NULL),
			       '[]'::jsonb
		       ) AS documents
		  FROM page`,
		params,
	);
	const listed = row?.documents ?? [];
	const page = listed.slice(0, opts.limit);
	const boundary = listed.length > opts.limit ? page.at(-1) : undefined;
	return {
		total: Number(row?.total ?? 0),
		documents: page.map(({ sourceAssetId: _, ...document }) => ({
			...document,
			createdAt: new Date(document.createdAt).toISOString(),
		})),
		next: boundary
			? {
					createdAt: new Date(boundary.createdAt).toISOString(),
					sourceAssetId: boundary.sourceAssetId,
				}
			: null,
	};
}

/** Lexical FTS over `search_tsv` with the `simple` config (no CJK tokenization). */
async function searchPassages(
	db: KbDb,
	opts: {
		workspaceId: string;
		query: string;
		documentIds: string[] | null;
		collectionId: string | null;
		limit: number;
	},
): Promise<SearchHit[]> {
	const params: unknown[] = [opts.workspaceId, opts.query];
	let joins = "";
	let filters = "";
	if (opts.collectionId) {
		params.push(opts.collectionId);
		joins +=
			" JOIN passage_collection pc ON pc.passage_id = p.id" +
			" JOIN content_collection c ON c.compat_int_id::text = pc.collection_id";
		filters += ` AND c.compat_str_id = $${params.length}`;
	}
	if (opts.documentIds) {
		const slots = opts.documentIds
			.map((_, i) => `$${params.length + i + 1}`)
			.join(", ");
		params.push(...opts.documentIds);
		filters += ` AND p.document_id IN (${slots})`;
	}
	params.push(opts.limit);
	const rows = await db.query<{
		passage_id: string;
		document_id: string;
		title: string;
		snippet: string;
	}>(
		`WITH current_documents AS (
			SELECT DISTINCT ON (d.source_asset_id) d.id, d.title
			  FROM document d
			  JOIN source_asset sa ON sa.id = d.source_asset_id
			 WHERE d.workspace_id = $1
			   AND d.status = 'active'
			   AND sa.workspace_id = $1
			   AND sa.status = 'ready'
			 ORDER BY d.source_asset_id, d.version DESC, d.id DESC
		)
		 SELECT p.id AS passage_id, p.document_id, d.title,
		        left(p.passage_text, 220) AS snippet,
		        ts_rank_cd(p.search_tsv, plainto_tsquery('simple', $2)) AS score
		   FROM passage p
		   JOIN current_documents d ON d.id = p.document_id${joins}
		  WHERE p.workspace_id = $1
		    AND p.status = 'active'
		    ${filters}
		    AND p.search_tsv @@ plainto_tsquery('simple', $2)
		  ORDER BY score DESC
		  LIMIT $${params.length}`,
		params,
	);
	return rows.map((r) => ({
		passageId: r.passage_id,
		documentId: r.document_id,
		title: r.title ?? "",
		snippet: r.snippet ?? "",
	}));
}

async function fetchDocument(
	db: KbDb,
	opts: { workspaceId: string; documentId: string },
): Promise<FetchedDocument | null> {
	const [row] = await db.query<{
		document_id: string;
		title: string;
		content: string;
		content_length: number;
	}>(
		`SELECT d.id AS document_id, d.title,
		        left(d.canonical_markdown, $3) AS content,
		        length(d.canonical_markdown) AS content_length
		   FROM document d
		   JOIN source_asset sa ON sa.id = d.source_asset_id
		  WHERE d.id = $1
		    AND d.workspace_id = $2
		    AND d.status = 'active'
		    AND sa.workspace_id = $2
		    AND sa.status = 'ready'
		    AND NOT EXISTS (
			    SELECT 1
			      FROM document newer
			     WHERE newer.source_asset_id = d.source_asset_id
			       AND newer.workspace_id = $2
			       AND newer.status = 'active'
			       AND (
				       newer.version > d.version OR
				       (newer.version = d.version AND newer.id > d.id)
			       )
		    )
		  LIMIT 1`,
		[opts.documentId, opts.workspaceId, MAX_DOCUMENT_CHARS],
	);
	if (!row) return null;
	return {
		documentId: row.document_id,
		title: row.title ?? "",
		content: row.content ?? "",
		truncated: Number(row.content_length ?? 0) > MAX_DOCUMENT_CHARS,
	};
}

async function documentInCollection(
	db: KbDb,
	opts: { collectionId: string; workspaceId: string; documentId: string },
): Promise<boolean> {
	const rows = await db.query(
		`SELECT 1
		   FROM content_collection c
		   JOIN passage_collection pc ON pc.collection_id = c.compat_int_id::text
		   JOIN passage p ON p.id = pc.passage_id
		  WHERE c.compat_str_id = $1
		    AND p.workspace_id = $2
		    AND p.document_id = $3
		    AND p.status = 'active'
		  LIMIT 1`,
		[opts.collectionId, opts.workspaceId, opts.documentId],
	);
	return rows.length > 0;
}

/** summaryId (= platform_knowledge.id) → current KB document id, or null. */
async function resolveDocumentId(
	db: KbDb,
	opts: { summaryId: string; memberCode: string },
): Promise<string | null> {
	// Fail closed on a non-numeric id rather than let `$1::bigint` raise.
	if (!/^\d+$/.test(opts.summaryId)) return null;
	const [row] = await db.query<{ kb_document_id: string }>(
		`SELECT current_version.id AS kb_document_id
		   FROM content_asset ca
		   JOIN document mapped ON mapped.id = ca.kb_document_id
		   JOIN LATERAL (
			   SELECT current_doc.id
			     FROM document current_doc
			     JOIN source_asset sa ON sa.id = current_doc.source_asset_id
			    WHERE current_doc.source_asset_id = mapped.source_asset_id
			      AND current_doc.workspace_id = $2
			      AND current_doc.status = 'active'
			      AND sa.workspace_id = $2
			      AND sa.status = 'ready'
			    ORDER BY current_doc.version DESC, current_doc.id DESC
			    LIMIT 1
		   ) current_version ON TRUE
		  WHERE ca.compat_int_id = $1::bigint
		    AND ca.member_code = $2
		    AND ca.kb_document_id <> ''
		  LIMIT 1`,
		[opts.summaryId, opts.memberCode],
	);
	return row?.kb_document_id ?? null;
}

/**
 * The client for one Harness turn: the frozen scope is applied server-side
 * before every query — the input carries no filter a caller could widen — and
 * every call appends one audit row with the turn's binding.
 */
export function createScopedDocumentClient(deps: {
	kb: KbDb;
	audit: DocumentAccessLog;
	logger: HarnessToolLogger;
	binding: HarnessToolBinding;
	scope: FrozenScope;
}): ScopedDocumentClient {
	const { kb, binding, scope } = deps;

	/** Narrow to the scope's document ids / collection; `null` means unresolvable. */
	async function narrowing(): Promise<{
		documentIds: string[] | null;
		collectionId: string | null;
	} | null> {
		if (scope.type === "document") {
			const documentId = await resolveDocumentId(kb, {
				summaryId: scope.summaryId,
				memberCode: binding.userId,
			});
			return documentId
				? { documentIds: [documentId], collectionId: null }
				: null;
		}
		return {
			documentIds: null,
			collectionId: scope.type === "collection" ? scope.collectionId : null,
		};
	}

	function audit(
		operation: "list" | "search" | "load",
		query: string | null,
		documentIds: string[],
		resultCount: number,
	): Promise<void> {
		return deps.audit.record({
			turnId: binding.turnId,
			conversationId: binding.conversationId,
			userId: binding.userId,
			operation,
			scopeType: scope.type,
			scopeId:
				scope.type === "collection"
					? scope.collectionId
					: scope.type === "document"
						? scope.summaryId
						: null,
			query,
			documentIds,
			resultCount,
		});
	}

	/** Infrastructure failures become a fixed message; scope errors pass through. */
	function bounded(failureMessage: string, error: unknown): Error {
		if (error instanceof DocumentAccessError) return error;
		deps.logger.error(
			{ err: error, ...binding },
			`harness document tool: ${failureMessage}`,
		);
		return new DocumentAccessError(failureMessage);
	}

	return {
		async list({ limit, after }) {
			try {
				const narrow = await narrowing();
				if (!narrow) {
					await audit("list", null, [], 0);
					return { total: 0, documents: [], next: null };
				}
				const page = await listDocuments(kb, {
					workspaceId: binding.userId,
					...narrow,
					limit,
					after,
				});
				await audit(
					"list",
					null,
					page.documents.map((d) => d.documentId),
					page.total,
				);
				return page;
			} catch (error) {
				throw bounded("document list failed", error);
			}
		},

		async search({ query, maxResults }) {
			try {
				const narrow = await narrowing();
				if (!narrow) {
					await audit("search", query, [], 0);
					return [];
				}
				const passages = await searchPassages(kb, {
					workspaceId: binding.userId,
					query,
					...narrow,
					limit: maxResults,
				});
				await audit(
					"search",
					query,
					[...new Set(passages.map((p) => p.documentId))],
					passages.length,
				);
				return passages;
			} catch (error) {
				throw bounded("document search failed", error);
			}
		},

		async fetch(documentId) {
			try {
				// Scope guard first: an out-of-scope id is rejected before any
				// document row is read or audited.
				const narrow = await narrowing();
				const admitted =
					narrow !== null &&
					(narrow.documentIds
						? narrow.documentIds.includes(documentId)
						: narrow.collectionId
							? await documentInCollection(kb, {
									collectionId: narrow.collectionId,
									workspaceId: binding.userId,
									documentId,
								})
							: true);
				if (!admitted) throw new DocumentAccessError(OUT_OF_SCOPE);
				const doc = await fetchDocument(kb, {
					workspaceId: binding.userId,
					documentId,
				});
				if (!doc) throw new DocumentAccessError(OUT_OF_SCOPE);
				await audit("load", null, [documentId], 1);
				return doc;
			} catch (error) {
				throw bounded("document fetch failed", error);
			}
		},
	};
}
