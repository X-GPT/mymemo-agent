import type { Hono } from "hono";
import { forbidden } from "../auth/bearer";
import { requireDocumentClaims } from "../auth/claims";
import type { Db } from "../db/client";
import {
	documentInCollection,
	fetchDocument,
	resolveDocumentId,
	searchPassages,
} from "../db/queries";
import type { GatewayConfig } from "../env";

/**
 * Document reader. The `mymemo-docs` CLI points at the gateway via
 * MYMEMO_DOC_GATEWAY_URL with the same token. We read the MyMemo knowledge base
 * (Postgres) directly and ENFORCE the turn's signed scope server-side, so a
 * prompt-injected agent cannot widen it. Search is FTS-only.
 */

const SEARCH_LIMIT = 8;

/**
 * Register the document routes. MUST be registered before the LLM catch-all (see
 * `server.ts`) so /v1/documents/* is handled here and never reaches the
 * Anthropic proxy.
 */
export function registerDocumentRoutes(
	app: Hono,
	config: GatewayConfig,
	db: Db,
): void {
	app.post("/v1/documents/search", async (c) => {
		const claims = requireDocumentClaims(c, config.llmTokenSecret);
		if (claims instanceof Response) return claims;

		const body = await c.req
			.json<{ query?: string }>()
			.catch(() => ({}) as { query?: string });
		if (!body.query) return c.json({ error: "query is required" }, 400);

		const workspaceId = claims.userId;

		try {
			// Server-side scope enforcement — narrow what is searchable.
			let documentIds: string[] | null = null;
			let collectionId: string | null = null;
			if (claims.scope === "document") {
				const docId = await resolveDocumentId(db, {
					summaryId: claims.summaryId ?? "",
					memberCode: claims.userId,
				});
				if (!docId) return c.json({ documents: [] });
				documentIds = [docId];
			} else if (claims.scope === "collection") {
				collectionId = claims.collectionId ?? "";
			}

			const documents = await searchPassages(db, {
				workspaceId,
				query: body.query,
				documentIds,
				collectionId,
				limit: SEARCH_LIMIT,
			});
			return c.json({ documents });
		} catch {
			return c.json({ error: "document search failed" }, 502);
		}
	});

	app.post("/v1/documents/fetch", async (c) => {
		const claims = requireDocumentClaims(c, config.llmTokenSecret);
		if (claims instanceof Response) return claims;

		const body = await c.req
			.json<{ documentId?: string }>()
			.catch(() => ({}) as { documentId?: string });
		if (!body.documentId)
			return c.json({ error: "documentId is required" }, 400);

		const workspaceId = claims.userId;

		try {
			// Server-side scope enforcement — the document must be in scope.
			if (claims.scope === "document") {
				const docId = await resolveDocumentId(db, {
					summaryId: claims.summaryId ?? "",
					memberCode: claims.userId,
				});
				if (!docId || body.documentId !== docId) {
					return forbidden(c, "document out of scope");
				}
			} else if (claims.scope === "collection") {
				const inCollection = await documentInCollection(db, {
					collectionId: claims.collectionId ?? "",
					workspaceId,
					documentId: body.documentId,
				});
				if (!inCollection) return forbidden(c, "document not in collection");
			}

			const doc = await fetchDocument(db, {
				workspaceId,
				documentId: body.documentId,
			});
			if (doc === null) return c.json({ error: "not found" }, 404);
			return c.json(doc);
		} catch {
			return c.json({ error: "document fetch failed" }, 502);
		}
	});
}
