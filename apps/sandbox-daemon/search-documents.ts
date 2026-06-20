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
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DocsManifest,
	readDocsManifest,
	upsertDocsManifestEntry,
} from "./docs-manifest";
import {
	DEFAULT_HYDRATION_LIMITS,
	type HydrationLimits,
} from "./hydration-policy";

/**
 * Max distinct documents hydrated per search call. Kept as a named export for
 * existing callers/tests; the configurable source of truth is now
 * {@link HydrationLimits.maxDocumentsPerSearch} (see hydration-policy.ts).
 */
export const MAX_HYDRATED_DOCUMENTS =
	DEFAULT_HYDRATION_LIMITS.maxDocumentsPerSearch;

/** Manifest `source` recorded for documents hydrated from the gateway. */
export const GATEWAY_SOURCE = "gateway";

/**
 * Result `source`:
 * - `"gateway"` — hydrated by this call.
 * - `"already_local"` — already present in the conversation workspace.
 * - `"skipped_too_large"` — fetched but over the per-document byte limit; NOT
 *   written to disk.
 * - `"skipped_run_budget"` — fetched but would push this run over its byte
 *   budget; NOT written to disk.
 *
 * For the two `skipped_*` sources `localPath` is `""` and `error` explains the
 * limit that was hit.
 */
export type DocumentResultSource =
	| typeof GATEWAY_SOURCE
	| "already_local"
	| "skipped_too_large"
	| "skipped_run_budget";

export interface SearchDocumentResult {
	documentId: string;
	source: DocumentResultSource;
	title: string;
	snippet: string;
	/**
	 * The passage the snippet came from. Carried through so the agent can satisfy
	 * the `passageId`-based citation contract (see the agent system prompt);
	 * `""` if the gateway hit omitted it. Search returns multiple passages per
	 * document — this is the top-ranked passage for the hydrated document.
	 */
	passageId: string;
	/**
	 * Absolute path to the hydrated file (the agent can `Read` this), or `""` for
	 * a `skipped_*` document that was not written to disk.
	 */
	localPath: string;
	/** Why a `skipped_*` document was not hydrated; absent on hydrated rows. */
	error?: string;
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
	/**
	 * Hydration caps (document count + byte ceilings). Defaults to
	 * {@link DEFAULT_HYDRATION_LIMITS}; the daemon passes env-derived limits.
	 */
	limits?: HydrationLimits;
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
	// A 200 with a non-JSON body (e.g. an HTML error page from a proxy/LB) would
	// otherwise throw a bare SyntaxError; normalize it to a GatewayDocumentError
	// so callers see one recoverable error type instead of two.
	try {
		return (await res.json()) as T;
	} catch (cause) {
		throw new GatewayDocumentError(
			`gateway returned a non-JSON body: ${(cause as Error).message}`,
		);
	}
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
 * and snippet for each), preserving search-rank order, capped at `maxDocuments`.
 * Hits without a `documentId` are dropped.
 */
function selectDocuments(
	hits: GatewaySearchHit[],
	maxDocuments: number,
): GatewaySearchHit[] {
	const seen = new Set<string>();
	const selected: GatewaySearchHit[] = [];
	for (const hit of hits) {
		const documentId = hit.documentId;
		if (!documentId || seen.has(documentId)) continue;
		seen.add(documentId);
		selected.push(hit);
		if (selected.length >= maxDocuments) break;
	}
	return selected;
}

/**
 * Bytes already hydrated under `runId`, summed from the byte count RECORDED in
 * the manifest at hydration time (not the live on-disk size). This seeds the
 * per-run budget so the cap holds across multiple `search_documents` calls in
 * the same run. Using the recorded count means a prompt-injectable agent can't
 * free budget by deleting or truncating a file it already hydrated — the charge
 * stands as long as the manifest entry does. Legacy entries without a recorded
 * `byteSize` contribute 0.
 */
function runHydratedBytes(manifest: DocsManifest, runId: string): number {
	let total = 0;
	for (const entry of manifest.documents) {
		if (entry.runId === runId) total += entry.byteSize ?? 0;
	}
	return total;
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
	const limits = deps.limits ?? DEFAULT_HYDRATION_LIMITS;

	const searchResponse = await postJson<{ documents?: unknown }>(
		doFetch,
		`${deps.gatewayUrl}/v1/documents/search`,
		deps.token,
		{ query },
	);
	const hits: GatewaySearchHit[] = Array.isArray(searchResponse.documents)
		? (searchResponse.documents as GatewaySearchHit[])
		: [];

	const selected = selectDocuments(hits, limits.maxDocumentsPerSearch);
	if (selected.length === 0) return [];

	// Read the manifest once up front so repeated searches recognise documents
	// already hydrated in this conversation workspace.
	const manifest = readDocsManifest(deps.docsDir);
	const localById = new Map(manifest.documents.map((d) => [d.documentId, d]));

	// Seed the per-run byte budget from what this run already hydrated, so the
	// cap holds across multiple search_documents calls in the run.
	let runBytes = runHydratedBytes(manifest, deps.runId);

	const results: SearchDocumentResult[] = [];
	for (const hit of selected) {
		// `documentId` is guaranteed by selectDocuments.
		const documentId = hit.documentId as string;
		const snippet = hit.snippet ?? "";
		const passageId = hit.passageId ?? "";

		// Treat a document as already-local only when both the manifest entry AND
		// the file are present. A manifest entry whose file is gone (the agent
		// deleted it, or a future workspace hydrate restored the manifest before
		// the blobs) must fall through to a re-fetch — otherwise we'd hand back a
		// path the agent's `Read` would fail on for a document that is in scope.
		const existing = localById.get(documentId);
		if (existing) {
			const existingPath = join(deps.docsDir, existing.localPath);
			if (existsSync(existingPath)) {
				results.push({
					documentId,
					source: "already_local",
					title: hit.title || existing.title,
					snippet,
					passageId,
					localPath: existingPath,
				});
				continue;
			}
		}

		// Run budget already exhausted: don't even fetch. Every remaining
		// non-local candidate would be discarded post-fetch anyway, so fetching
		// them just burns gateway cost — the cap is meant to bound exactly that.
		// (A doc small enough to still fit is handled by the post-fetch check
		// below; this short-circuits only once nothing more can fit at all.)
		if (runBytes >= limits.maxBytesPerRun) {
			results.push({
				documentId,
				source: "skipped_run_budget",
				title: hit.title || "",
				snippet,
				passageId,
				localPath: "",
				error: `per-run hydration budget of ${limits.maxBytesPerRun} bytes is exhausted (already ${runBytes})`,
			});
			continue;
		}

		const doc = await postJson<GatewayFetchedDocument>(
			doFetch,
			`${deps.gatewayUrl}/v1/documents/fetch`,
			deps.token,
			{ documentId },
		);

		const content = doc.content ?? "";
		const byteLength = Buffer.byteLength(content, "utf8");
		const title = doc.title || hit.title || "";

		// Enforce the byte caps BEFORE touching disk: an oversized or
		// budget-busting document is reported, never written. Per-document is
		// checked first so a single huge file is attributed to its own limit
		// rather than the run budget it would also blow.
		if (byteLength > limits.maxBytesPerDocument) {
			results.push({
				documentId,
				source: "skipped_too_large",
				title,
				snippet,
				passageId,
				localPath: "",
				error: `document is ${byteLength} bytes, over the per-document limit of ${limits.maxBytesPerDocument}`,
			});
			continue;
		}
		if (runBytes + byteLength > limits.maxBytesPerRun) {
			results.push({
				documentId,
				source: "skipped_run_budget",
				title,
				snippet,
				passageId,
				localPath: "",
				error: `hydrating ${byteLength} bytes would exceed the per-run budget of ${limits.maxBytesPerRun} bytes (already ${runBytes})`,
			});
			continue;
		}

		const filename = documentFilename(documentId);
		const absolutePath = join(deps.docsDir, filename);
		writeFileSync(absolutePath, content, "utf8");
		runBytes += byteLength;
		upsertDocsManifestEntry(deps.docsDir, {
			documentId,
			title,
			localPath: filename,
			source: GATEWAY_SOURCE,
			hydratedAt: now().toISOString(),
			runId: deps.runId,
			byteSize: byteLength,
		});

		results.push({
			documentId,
			source: GATEWAY_SOURCE,
			title,
			snippet,
			passageId,
			localPath: absolutePath,
		});
	}

	return results;
}
