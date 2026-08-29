import path from "node:path/posix";
import type {
	DocumentListCursor,
	ScopedDocumentClient,
} from "./document-client";

/**
 * The three document-tool handlers, bounded by code constants that mirror the
 * Run path (`apps/agentcore-runtime/src/documents/`). Each returns the plain
 * JSON the model sees, or `{ isError, text }`, which `execute()` throws.
 */

export const DOCUMENT_TOOL_LIMITS = {
	listMaxResults: 20,
	searchMaxResults: 8,
	load: {
		maxDocuments: 10,
		perDocumentMaxBytes: 262_144,
		perCallMaxBytes: 1_048_576,
	},
} as const;

/** Materialized documents live here under the session work directory. */
export const DOCS_CACHE_DIRNAME = ".mymemo/docs";

/** Appended to a cached file whose content was clipped, so the marker is on disk too. */
export const LOAD_TRUNCATION_NOTICE =
	"\n\n[mymemo: document truncated at load — content exceeds the load size cap]\n";

export interface ToolFailure {
	isError: true;
	text: string;
}

function fail(text: string): ToolFailure {
	return { isError: true, text };
}

const CURSOR_VERSION = 1;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function encodeCursor(cursor: DocumentListCursor): string {
	return Buffer.from(
		JSON.stringify({ version: CURSOR_VERSION, ...cursor }),
	).toString("base64url");
}

function decodeCursor(cursor: string): DocumentListCursor | null {
	if (cursor.length === 0 || cursor.length > 4_096 || !BASE64URL.test(cursor)) {
		return null;
	}
	try {
		const decoded = Buffer.from(cursor, "base64url");
		if (decoded.toString("base64url") !== cursor) return null;
		const parsed: unknown = JSON.parse(decoded.toString("utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("version" in parsed) ||
			parsed.version !== CURSOR_VERSION ||
			!("createdAt" in parsed) ||
			typeof parsed.createdAt !== "string" ||
			!Number.isFinite(Date.parse(parsed.createdAt)) ||
			!("sourceAssetId" in parsed) ||
			typeof parsed.sourceAssetId !== "string" ||
			parsed.sourceAssetId.length === 0
		) {
			return null;
		}
		return {
			createdAt: new Date(parsed.createdAt).toISOString(),
			sourceAssetId: parsed.sourceAssetId,
		};
	} catch {
		return null;
	}
}

function boundedMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

export interface ListDocumentsInput {
	limit?: number;
	cursor?: string;
}

export async function listDocuments(
	input: ListDocumentsInput,
	client: ScopedDocumentClient,
) {
	const max = DOCUMENT_TOOL_LIMITS.listMaxResults;
	const limit = Math.min(max, Math.max(1, Math.floor(input.limit ?? max)));
	const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
	if (input.cursor !== undefined && after === null) {
		return fail("ListDocuments failed: invalid cursor");
	}
	try {
		const page = await client.list({ limit, after });
		return {
			total: page.total,
			documents: page.documents,
			nextCursor: page.next ? encodeCursor(page.next) : null,
		};
	} catch (error) {
		return fail(`ListDocuments failed: ${boundedMessage(error)}`);
	}
}

export interface SearchDocumentsInput {
	query: string;
	maxResults?: number;
}

export async function searchDocuments(
	input: SearchDocumentsInput,
	client: ScopedDocumentClient,
) {
	const query = input.query.trim();
	if (!query) return fail("SearchDocuments requires a non-empty query.");
	const max = DOCUMENT_TOOL_LIMITS.searchMaxResults;
	try {
		const passages = await client.search({
			query,
			maxResults:
				input.maxResults === undefined
					? max
					: Math.min(max, Math.max(1, Math.floor(input.maxResults))),
		});
		return passages.length === 0
			? {
					passages,
					message: "No MyMemo document passages matched the query.",
				}
			: { passages };
	} catch (error) {
		return fail(`SearchDocuments failed: ${boundedMessage(error)}`);
	}
}

export interface LoadDocumentsInput {
	documentIds: string[];
}

/** The write-only seam LoadDocuments needs from the Harness sandbox session. */
export interface DocsCacheWriter {
	writeTextFile(options: {
		path: string;
		content: string;
		abortSignal?: AbortSignal;
	}): PromiseLike<void>;
}

/** KB document ids that are safe to use verbatim as a cache filename. */
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9._-]+$/;

/** Take a whole-character prefix within `maxBytes` UTF-8 bytes. */
function takeUtf8Bytes(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { text, truncated: false };
	}
	let bytes = 0;
	let output = "";
	for (const char of text) {
		bytes += Buffer.byteLength(char, "utf8");
		if (bytes > maxBytes) break;
		output += char;
	}
	return { text: output, truncated: true };
}

/**
 * Materialize scope-checked documents to `<workDir>/.mymemo/docs/<id>.md`
 * through the sandbox session, so the model can `Read` and `Grep` them. The
 * result carries paths and byte counts only, never a document body.
 */
export async function loadDocuments(
	input: LoadDocumentsInput,
	context: {
		client: ScopedDocumentClient;
		sandbox: DocsCacheWriter;
		/** Absolute session work directory. */
		workDir: string;
		abortSignal?: AbortSignal;
	},
) {
	const limits = DOCUMENT_TOOL_LIMITS.load;
	const ids = [...new Set(input.documentIds)];
	if (ids.length === 0) {
		return fail("LoadDocuments requires at least one document id.");
	}
	if (ids.length > limits.maxDocuments) {
		return fail(
			`LoadDocuments accepts at most ${limits.maxDocuments} document ids per call.`,
		);
	}
	const cacheRoot = path.join(context.workDir, DOCS_CACHE_DIRNAME);
	const loaded: {
		documentId: string;
		title: string;
		path: string;
		bytes: number;
		truncated: boolean;
	}[] = [];
	const errors: { documentId: string; error: string }[] = [];
	let remainingCallBytes = limits.perCallMaxBytes;

	for (const documentId of ids) {
		if (!SAFE_DOCUMENT_ID.test(documentId)) {
			errors.push({
				documentId,
				error: "document id is not a valid identifier.",
			});
			continue;
		}
		// Budget check before the fetch: an exhausted call neither reads the KB
		// nor audits a document it cannot cache.
		if (remainingCallBytes <= 0) {
			errors.push({
				documentId,
				error: "per-call byte budget exhausted; load fewer documents.",
			});
			continue;
		}
		let fetched: Awaited<ReturnType<ScopedDocumentClient["fetch"]>>;
		try {
			fetched = await context.client.fetch(documentId);
		} catch (error) {
			errors.push({ documentId, error: boundedMessage(error) });
			continue;
		}
		const clipped = takeUtf8Bytes(
			fetched.content,
			Math.min(limits.perDocumentMaxBytes, remainingCallBytes),
		);
		const truncated = clipped.truncated || fetched.truncated;
		const filePath = path.join(cacheRoot, `${documentId}.md`);
		try {
			await context.sandbox.writeTextFile({
				path: filePath,
				content: truncated
					? clipped.text + LOAD_TRUNCATION_NOTICE
					: clipped.text,
				abortSignal: context.abortSignal,
			});
		} catch (error) {
			errors.push({
				documentId,
				error: `failed to cache document: ${boundedMessage(error)}`,
			});
			continue;
		}
		// Only the document content counts against the budget; the marker does not.
		const bytes = Buffer.byteLength(clipped.text, "utf8");
		remainingCallBytes -= bytes;
		loaded.push({
			documentId,
			title: fetched.title,
			path: filePath,
			bytes,
			truncated,
		});
	}
	return { loaded, errors };
}
