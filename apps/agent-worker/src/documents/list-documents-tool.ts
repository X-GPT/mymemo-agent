import type { DocumentAccessBinding } from "./audit";
import type { DocumentListCursor, DocumentListPage } from "./kb-queries";
import type { FrozenConversationScope } from "./scope";

export type {
	DocumentListCursor,
	DocumentListPage,
	ListedDocument,
} from "./kb-queries";

export interface ListDocumentsToolInput {
	limit?: number;
	cursor?: string;
}

export interface ListDocumentsClient {
	listDocuments(input: {
		binding: DocumentAccessBinding;
		scope: FrozenConversationScope;
		limit: number;
		after: DocumentListCursor | null;
	}): Promise<DocumentListPage>;
}

export interface ListDocumentsToolContext {
	client: ListDocumentsClient;
	binding: DocumentAccessBinding;
	scope: FrozenConversationScope;
	maxResults: number;
}

export interface ListDocumentsToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

const CURSOR_VERSION = 1;
const MAX_LIST_RESULTS = 100;
const BASE64URL_CURSOR = /^[A-Za-z0-9_-]+$/;

function encodeCursor(cursor: DocumentListCursor): string {
	return Buffer.from(
		JSON.stringify({ version: CURSOR_VERSION, ...cursor }),
	).toString("base64url");
}

function decodeCursor(cursor: string): DocumentListCursor | null {
	if (
		cursor.length === 0 ||
		cursor.length > 4_096 ||
		!BASE64URL_CURSOR.test(cursor)
	) {
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

function toolText(payload: unknown): ListDocumentsToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

function toolError(message: string): ListDocumentsToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

export async function runListDocumentsTool(
	input: ListDocumentsToolInput,
	context: ListDocumentsToolContext,
): Promise<ListDocumentsToolResult> {
	const limit = Math.min(
		MAX_LIST_RESULTS,
		context.maxResults,
		Math.max(1, Math.floor(input.limit ?? context.maxResults)),
	);
	const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
	if (input.cursor !== undefined && after === null) {
		return toolError("ListDocuments failed: invalid cursor");
	}
	try {
		const result = await context.client.listDocuments({
			binding: context.binding,
			scope: context.scope,
			limit,
			after,
		});
		return toolText({
			total: result.total,
			documents: result.documents,
			nextCursor: result.next ? encodeCursor(result.next) : null,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toolError(`ListDocuments failed: ${message}`);
	}
}
