import type { DocumentAccessBinding } from "./audit";
import type { ScopedDocumentQueryClient } from "./client";
import type { FrozenConversationScope } from "./scope";

export const SEARCH_DOCUMENTS_TOOL_NAME = "SearchDocuments";

export interface SearchDocumentsToolInput {
	query: string;
	maxResults?: number;
}

export interface SearchDocumentsToolContext {
	client: ScopedDocumentQueryClient;
	binding: DocumentAccessBinding;
	scope: FrozenConversationScope;
	maxResults: number;
}

export interface SearchDocumentsToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

function toolText(payload: unknown): SearchDocumentsToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

function toolError(message: string): SearchDocumentsToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

function clampRequestedMaxResults(
	requested: number | undefined,
	configuredMax: number,
): number {
	if (requested === undefined) return configuredMax;
	return Math.min(configuredMax, Math.max(1, Math.floor(requested)));
}

/**
 * Model-facing SearchDocuments tool handler. It intentionally depends only on
 * the scoped query client, never a Db, so scope checks and audit writes stay in
 * the trusted document module.
 */
export async function runSearchDocumentsTool(
	input: SearchDocumentsToolInput,
	context: SearchDocumentsToolContext,
): Promise<SearchDocumentsToolResult> {
	const query = input.query.trim();
	if (!query) return toolError("SearchDocuments requires a non-empty query.");

	try {
		const { passages } = await context.client.searchDocuments({
			binding: context.binding,
			scope: context.scope,
			query,
			maxResults: clampRequestedMaxResults(
				input.maxResults,
				context.maxResults,
			),
		});

		if (passages.length === 0) {
			return toolText({
				passages: [],
				message: "No MyMemo document passages matched the query.",
			});
		}

		return toolText({
			passages: passages.map((passage) => ({
				passageId: passage.passageId,
				documentId: passage.documentId,
				title: passage.title,
				snippet: passage.snippet,
			})),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toolError(`SearchDocuments failed: ${message}`);
	}
}
