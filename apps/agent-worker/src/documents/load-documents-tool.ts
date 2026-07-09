import path from "node:path/posix";
import type { DocumentAccessBinding } from "./audit";
import type { ScopedDocumentQueryClient } from "./client";
import type { FrozenConversationScope } from "./scope";

export const LOAD_DOCUMENTS_TOOL_NAME = "LoadDocuments";

/**
 * Reserved, conversation-scoped docs cache under the sandbox workspace root
 * (ADR-0004). Hidden so it stays out of the agent's default file listings and
 * is never mistaken for user work; the model reaches a cached file through the
 * exact `path` returned in the tool result.
 */
export const DOCS_CACHE_DIRNAME = ".mymemo/docs";

/** Appended to a cached file whose content was clipped, so the marker is on disk too. */
export const LOAD_TRUNCATION_NOTICE =
	"\n\n[mymemo: document truncated at load — content exceeds the load size cap]\n";

/** KB document ids that are safe to use verbatim as a cache filename. */
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9._-]+$/;

export interface LoadDocumentsToolInput {
	documentIds: string[];
}

export interface LoadDocumentsLimits {
	/** Most ids one call may load, bounding both KB reads and result size. */
	maxDocuments: number;
	/** Byte cap on a single document's cached content. */
	perDocumentMaxBytes: number;
	/** Byte cap on the summed content written across one call. */
	perCallMaxBytes: number;
}

/** The narrow sandbox seam LoadDocuments needs: write-only (ADR-0004). */
export interface LoadDocumentsCacheWriter {
	writeFile(input: { path: string; content: string }): Promise<void>;
}

export interface LoadDocumentsToolContext {
	client: ScopedDocumentQueryClient;
	sandbox: LoadDocumentsCacheWriter;
	binding: DocumentAccessBinding;
	scope: FrozenConversationScope;
	/** Absolute workspace root; the reserved cache dir is derived from it. */
	workspaceRoot: string;
	limits: LoadDocumentsLimits;
}

interface LoadedDocument {
	documentId: string;
	title: string;
	/** Workspace-rooted (relative) path to the cached file. */
	path: string;
	truncated: boolean;
}

interface LoadError {
	documentId: string;
	error: string;
}

export interface LoadDocumentsToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

function toolText(payload: unknown): LoadDocumentsToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

function toolError(message: string): LoadDocumentsToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Distinct ids in first-seen order — repeats would only re-fetch and re-audit. */
function dedupe(ids: string[]): string[] {
	return [...new Set(ids)];
}

/**
 * Materialize scope-checked KB documents into the conversation's reserved docs
 * cache (plan Task 6.3, ADR-0004). Content goes to disk via the sandbox writer;
 * the result carries metadata only, so no document body ever reaches run events
 * or tool-result persistence. Scope checks, capping, and the
 * `document_access_events` audit all live behind `fetchDocumentInScope`, so the
 * KB credential never leaves the trusted worker and unknown/out-of-scope ids
 * fail with one uniform message that cannot probe cross-scope existence.
 */
export async function runLoadDocumentsTool(
	input: LoadDocumentsToolInput,
	context: LoadDocumentsToolContext,
): Promise<LoadDocumentsToolResult> {
	const ids = dedupe(input.documentIds ?? []);
	if (ids.length === 0) {
		return toolError("LoadDocuments requires at least one document id.");
	}
	if (ids.length > context.limits.maxDocuments) {
		return toolError(
			`LoadDocuments accepts at most ${context.limits.maxDocuments} document ids per call.`,
		);
	}

	const workspaceRoot = path.normalize(context.workspaceRoot);
	const cacheRoot = path.join(workspaceRoot, DOCS_CACHE_DIRNAME);

	const loaded: LoadedDocument[] = [];
	const errors: LoadError[] = [];
	let remainingCallBytes = context.limits.perCallMaxBytes;

	for (const documentId of ids) {
		if (!SAFE_DOCUMENT_ID.test(documentId)) {
			errors.push({
				documentId,
				error: "document id is not a valid identifier.",
			});
			continue;
		}
		// Check the shared budget BEFORE fetching so an exhausted call neither
		// reads the KB nor writes an audit row for a document it cannot cache.
		if (remainingCallBytes <= 0) {
			errors.push({
				documentId,
				error: "per-call byte budget exhausted; load fewer documents.",
			});
			continue;
		}

		let fetched: Awaited<
			ReturnType<ScopedDocumentQueryClient["fetchDocumentInScope"]>
		>;
		try {
			fetched = await context.client.fetchDocumentInScope({
				binding: context.binding,
				scope: context.scope,
				documentId,
			});
		} catch (error) {
			// DocumentScopeError / DocumentQueryError messages are already bounded
			// and model-safe; surface them verbatim.
			errors.push({ documentId, error: boundedMessage(error) });
			continue;
		}

		const budget = Math.min(
			context.limits.perDocumentMaxBytes,
			remainingCallBytes,
		);
		const clipped = takeUtf8Bytes(fetched.content, budget);
		const truncated = clipped.truncated || fetched.truncated;
		const fileBody = truncated
			? clipped.text + LOAD_TRUNCATION_NOTICE
			: clipped.text;

		const absolutePath = path.join(cacheRoot, `${documentId}.md`);
		try {
			await context.sandbox.writeFile({
				path: absolutePath,
				content: fileBody,
			});
		} catch (error) {
			errors.push({
				documentId,
				error: `failed to cache document: ${boundedMessage(error)}`,
			});
			continue;
		}

		// Only the document content counts against the budget; the marker does not.
		remainingCallBytes -= utf8ByteLength(clipped.text);
		loaded.push({
			documentId,
			title: fetched.title,
			path: path.relative(workspaceRoot, absolutePath),
			truncated,
		});
	}

	return toolText({ loaded, errors });
}

/** Take a whole-character prefix within `maxBytes` UTF-8 bytes (no split runes). */
function takeUtf8Bytes(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const encoder = new TextEncoder();
	let bytes = 0;
	let output = "";
	for (const char of text) {
		const nextBytes = encoder.encode(char).byteLength;
		if (bytes + nextBytes > maxBytes) return { text: output, truncated: true };
		bytes += nextBytes;
		output += char;
	}
	return { text: output, truncated: false };
}

function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function boundedMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}
