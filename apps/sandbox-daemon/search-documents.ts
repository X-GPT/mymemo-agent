/**
 * `search_documents` — the single document operation exposed to the agent.
 *
 * One call does the whole working-set flow so the agent never has to chain a
 * separate search then fetch (the old `mymemo-docs search`/`fetch` split):
 *
 *   1. Search the remote index through the unified gateway (`/v1/documents/search`).
 *   2. Select the top distinct documents within the hydration cap.
 *   3. For each, hydrate into the conversation's `docs/` dir — unless it is
 *      already in the docs manifest, in which case it is reported as
 *      `already_local` and re-fetched from neither the gateway nor disk.
 *   4. Fetch full content through the gateway (`/v1/documents/fetch`), write it
 *      to local disk, and upsert the docs manifest.
 *   5. Return one row per document: `{ documentId, source, title, snippet,
 *      localPath }`, where `localPath` is an absolute path the agent can `Read`.
 *
 * This module holds NO credential and reads NO environment: the gateway URL +
 * bearer token and the workspace paths are injected by the caller
 * (`agent-tools.ts`, which reads them from the per-turn env the daemon set). The
 * `fetch` and clock are injectable so the flow is unit-testable without a live
 * gateway.
 *
 * Gateway failures throw {@link GatewayDocumentError}; the MCP tool wrapper turns
 * that into a recoverable tool error (`isError: true`) so the agent can retry or
 * explain instead of crashing the query loop. No matches is NOT an error — it
 * returns an empty result.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDocsManifest, upsertDocsManifestEntry } from "./docs-manifest";

/**
 * Max distinct documents hydrated per search call. A conservative interim cap so
 * one call can't fill the workspace; MYM-12 (Task 8) will centralize hydration
 * limits (per-document and per-run byte ceilings) in a dedicated policy module.
 */
export const MAX_HYDRATED_DOCUMENTS = 5;

/** Manifest `source` recorded for documents hydrated from the gateway. */
export const GATEWAY_SOURCE = "gateway";

/**
 * Result `source`: `"gateway"` for a document hydrated by this call,
 * `"already_local"` for one already present in the conversation workspace.
 */
export type DocumentResultSource = typeof GATEWAY_SOURCE | "already_local";

export interface SearchDocumentResult {
	documentId: string;
	source: DocumentResultSource;
	title: string;
	snippet: string;
	/** Absolute path to the hydrated file (the agent can `Read` this). */
	localPath: string;
}

/** One passage hit from the gateway search endpoint. */
interface GatewaySearchHit {
	passageId?: string;
	documentId?: string;
	title?: string;
	snippet?: string;
}

/** A fetched document from the gateway fetch endpoint. */
interface GatewayFetchedDocument {
	documentId?: string;
	title?: string;
	content?: string;
}

export interface SearchDocumentsDeps {
	/** Document gateway base URL (from `MYMEMO_DOC_GATEWAY_URL`). */
	gatewayUrl: string;
	/** Document bearer token, `aud: "documents"` (from `MYMEMO_DOC_TOKEN`). */
	token: string;
	/** Absolute path to the conversation's `docs/` dir (hydration + manifest home). */
	docsDir: string;
	/** The run that caused this hydration (recorded in the manifest). */
	runId: string;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable clock for deterministic `hydratedAt`; defaults to `() => new Date()`. */
	now?: () => Date;
}

/** Raised on any non-OK or unreachable gateway response. */
export class GatewayDocumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayDocumentError";
	}
}

async function postJson<T>(
	doFetch: typeof fetch,
	url: string,
	token: string,
	body: unknown,
): Promise<T> {
	let res: Response;
	try {
		res = await doFetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});
	} catch (cause) {
		throw new GatewayDocumentError(
			`gateway unreachable: ${(cause as Error).message}`,
		);
	}
	if (!res.ok) {
		// The body may carry a useful error message, but it could also echo input;
		// keep it short and never include the bearer token.
		throw new GatewayDocumentError(`gateway returned ${res.status}`);
	}
	return res.json() as Promise<T>;
}

/**
 * Map a remote document id to a safe local filename. The id comes from the
 * gateway, but never trust a remote value as a path: collapse anything outside
 * `[A-Za-z0-9_-]` so it cannot traverse out of `docs/`.
 *
 * Collapsing is lossy, so two distinct ids could map to the same name (e.g.
 * `a/b` and `a_b` both → `a_b`), which would clobber one document's file while
 * the manifest still holds both entries — the stale entry would then point at
 * the other document's content. A clean id (unchanged by sanitization) can't
 * collide, so it keeps its readable name; any id that had to be rewritten gets a
 * short hash of the *original* id appended, so distinct ids always get distinct
 * files.
 */
export function documentFilename(documentId: string): string {
	const safe = documentId.replace(/[^A-Za-z0-9_-]/g, "_");
	if (safe.length > 0 && safe === documentId) return `${safe}.md`;
	const hash = createHash("sha256")
		.update(documentId)
		.digest("hex")
		.slice(0, 8);
	return `${safe || "document"}.${hash}.md`;
}

/**
 * Dedupe passage hits down to distinct documents (keeping the first hit's title
 * and snippet for each), preserving search-rank order, capped at
 * {@link MAX_HYDRATED_DOCUMENTS}. Hits without a `documentId` are dropped.
 */
function selectDocuments(hits: GatewaySearchHit[]): GatewaySearchHit[] {
	const seen = new Set<string>();
	const selected: GatewaySearchHit[] = [];
	for (const hit of hits) {
		const documentId = hit.documentId;
		if (!documentId || seen.has(documentId)) continue;
		seen.add(documentId);
		selected.push(hit);
		if (selected.length >= MAX_HYDRATED_DOCUMENTS) break;
	}
	return selected;
}

/**
 * Run the full search → select → hydrate → manifest flow and return one row per
 * selected document. Throws {@link GatewayDocumentError} on gateway failure;
 * returns `[]` when the search has no matches.
 */
export async function searchAndHydrate(
	query: string,
	deps: SearchDocumentsDeps,
): Promise<SearchDocumentResult[]> {
	const doFetch = deps.fetchImpl ?? fetch;
	const now = deps.now ?? (() => new Date());

	const searchResponse = await postJson<{ documents?: unknown }>(
		doFetch,
		`${deps.gatewayUrl}/v1/documents/search`,
		deps.token,
		{ query },
	);
	const hits: GatewaySearchHit[] = Array.isArray(searchResponse.documents)
		? (searchResponse.documents as GatewaySearchHit[])
		: [];

	const selected = selectDocuments(hits);
	if (selected.length === 0) return [];

	// Read the manifest once up front so repeated searches recognise documents
	// already hydrated in this conversation workspace.
	const manifest = readDocsManifest(deps.docsDir);
	const localById = new Map(manifest.documents.map((d) => [d.documentId, d]));

	const results: SearchDocumentResult[] = [];
	for (const hit of selected) {
		// `documentId` is guaranteed by selectDocuments.
		const documentId = hit.documentId as string;
		const snippet = hit.snippet ?? "";

		const existing = localById.get(documentId);
		if (existing) {
			results.push({
				documentId,
				source: "already_local",
				title: hit.title || existing.title,
				snippet,
				localPath: join(deps.docsDir, existing.localPath),
			});
			continue;
		}

		const doc = await postJson<GatewayFetchedDocument>(
			doFetch,
			`${deps.gatewayUrl}/v1/documents/fetch`,
			deps.token,
			{ documentId },
		);

		const filename = documentFilename(documentId);
		const absolutePath = join(deps.docsDir, filename);
		const title = doc.title || hit.title || "";
		writeFileSync(absolutePath, doc.content ?? "", "utf8");
		upsertDocsManifestEntry(deps.docsDir, {
			documentId,
			title,
			localPath: filename,
			source: GATEWAY_SOURCE,
			hydratedAt: now().toISOString(),
			runId: deps.runId,
		});

		results.push({
			documentId,
			source: GATEWAY_SOURCE,
			title,
			snippet,
			localPath: absolutePath,
		});
	}

	return results;
}
