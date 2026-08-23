import type { Db } from "./db";

/**
 * Read-side of the MyMemo knowledge base, FTS-only. This Runtime path is the sole
 * implementation of scoped document access since the split runtime replaced the
 * prototype gateway's document module (ADR-0002).
 *
 * Scope mapping (derived from the platform's compat layer):
 *   - workspace_id  = the user's member_code (personal workspace)
 *   - summaryId     = platform_knowledge.id = content_asset.compat_int_id
 *                     → content_asset.kb_document_id = document.id
 *   - collectionId  = platform_collection.compat_id = content_collection.compat_str_id
 *                     → content_collection.compat_int_id = passage_collection.collection_id
 */

export interface SearchHit {
	passageId: string;
	documentId: string;
	title: string;
	snippet: string;
}

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

interface ListedDocumentRow extends ListedDocument {
	sourceAssetId: string;
}

export interface DocumentListPage {
	total: number;
	documents: ListedDocument[];
	next: DocumentListCursor | null;
}

/**
 * List logical searchable documents newest-first. `current_documents` reduces
 * immutable indexed versions to the highest active version per source asset;
 * the exact total and the bounded page come from one Postgres statement.
 */
export async function listDocuments(
	db: Db,
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
		if (opts.documentIds.length === 0) {
			return { total: 0, documents: [], next: null };
		}
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
	const rows = await db.query<{
		total: number;
		documents: ListedDocumentRow[];
	}>(
		`WITH current_documents AS (
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
		), scoped_documents AS (
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
	const row = rows[0];
	const listed = row?.documents ?? [];
	const page = listed.slice(0, opts.limit);
	const boundary =
		listed.length > opts.limit ? page[page.length - 1] : undefined;
	return {
		total: Number(row?.total ?? 0),
		documents: page.map(({ sourceAssetId: _sourceAssetId, ...document }) => ({
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

/**
 * Lexical full-text search over passages, scoped to a workspace and narrowed by
 * the frozen scope's filters: an optional collection (joined via
 * passage_collection) and/or an optional set of document ids. Uses the
 * precomputed `search_tsv` column with the `simple` config — no language
 * detection / CJK tokenization (FTS-only).
 */
export async function searchPassages(
	db: Db,
	opts: {
		workspaceId: string;
		query: string;
		documentIds: string[] | null; // document scope: restrict to these ids
		collectionId: string | null; // collection scope: join passage_collection
		limit: number;
	},
): Promise<SearchHit[]> {
	const params: unknown[] = [opts.workspaceId, opts.query];
	let joins = "";
	let filters = "";

	// Collection scope: join membership in one query — no pre-materialized id
	// list, so no extra round trip and no Postgres parameter-limit blow-up on a
	// huge collection. compat_str_id → compat_int_id → passage_collection.
	if (opts.collectionId) {
		params.push(opts.collectionId);
		joins +=
			" JOIN passage_collection pc ON pc.passage_id = p.id" +
			" JOIN content_collection c ON c.compat_int_id::text = pc.collection_id";
		filters += ` AND c.compat_str_id = $${params.length}`;
	}

	// Document scope: restrict to specific ids, one `$n` slot per id.
	if (opts.documentIds) {
		if (opts.documentIds.length === 0) return [];
		const slots = opts.documentIds
			.map((_, i) => `$${params.length + i + 1}`)
			.join(", ");
		params.push(...opts.documentIds);
		filters += ` AND p.document_id IN (${slots})`;
	}

	const limitSlot = `$${params.length + 1}`;
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
		  LIMIT ${limitSlot}`,
		params,
	);
	return rows.map((r) => ({
		passageId: r.passage_id,
		documentId: r.document_id,
		title: r.title ?? "",
		snippet: r.snippet ?? "",
	}));
}

export interface FetchedDocument {
	documentId: string;
	title: string;
	content: string;
	/** True when the stored document is longer than the excerpt cap. */
	truncated: boolean;
}

/**
 * Fetch a single document's content, pinned to the workspace and clipped to
 * `maxChars` server-side so a large document can never dump hundreds of KB
 * into the Runtime. The full length is read alongside so truncation is
 * reported, not silent.
 */
export async function fetchDocument(
	db: Db,
	opts: { workspaceId: string; documentId: string; maxChars: number },
): Promise<FetchedDocument | null> {
	const rows = await db.query<{
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
		[opts.documentId, opts.workspaceId, opts.maxChars],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		documentId: row.document_id,
		title: row.title ?? "",
		content: row.content ?? "",
		truncated: Number(row.content_length ?? 0) > opts.maxChars,
	};
}

/**
 * Collection scope (fetch): is `documentId` in the frozen collection, within
 * the user's workspace? compat_str_id → compat_int_id → passage_collection.
 *
 * User scoping is the `p.workspace_id = $2` pin, NOT `content_collection
 * .member_code` (which is stored in a different representation — verified
 * against staging: pinning by workspace matches the collection's docs and a
 * cross-workspace collectionId matches nothing).
 */
export async function documentInCollection(
	db: Db,
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

/**
 * Document scope: resolve the conversation's summaryId (= platform_knowledge
 * .id) to the KB document.id, pinned to the user's member_code. Returns null
 * if not found.
 */
export async function resolveDocumentId(
	db: Db,
	opts: { summaryId: string; memberCode: string },
): Promise<string | null> {
	// summaryId is platform_knowledge.id (a bigint). Fail closed on anything
	// non-numeric rather than letting `$1::bigint` raise a SQL error.
	if (!/^\d+$/.test(opts.summaryId)) return null;
	const rows = await db.query<{ kb_document_id: string }>(
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
	return rows[0]?.kb_document_id ?? null;
}
