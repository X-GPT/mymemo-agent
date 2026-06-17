/**
 * Durable docs manifest. This is the chat-api-side view of the same
 * `manifest.json` the sandbox-daemon maintains inside each conversation's
 * `docs/` directory (see `apps/sandbox-daemon/docs-manifest.ts` — that file is
 * the source of truth for the on-disk format). The durable store keeps its own
 * copy under `users/{userId}/conversations/{conversationId}/docs/manifest.json`
 * so the working set survives a sandbox being torn down.
 *
 * The same two correctness properties as the daemon apply:
 *   - Reads fail closed. A present-but-unparseable manifest throws rather than
 *     being silently treated as empty and overwritten.
 *   - Writes are atomic. We write a sibling temp file and rename it into place,
 *     so a reader never observes a half-written `manifest.json`.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Current on-disk schema version. Must match the daemon's manifest version. */
export const DOCS_MANIFEST_VERSION = 1;

const MANIFEST_FILENAME = "manifest.json";

export interface DocsManifestEntry {
	/** Remote document id (stable across hydrations). */
	documentId: string;
	/** Human-readable title from the source. */
	title: string;
	/** Path to the hydrated file, relative to the `docs/` directory. */
	localPath: string;
	/** Where the document came from (e.g. the gateway document source). */
	source: string;
	/** ISO-8601 time the document was hydrated or last updated. */
	hydratedAt: string;
	/** The run that caused this hydration. */
	runId: string;
}

export interface DocsManifest {
	version: typeof DOCS_MANIFEST_VERSION;
	documents: DocsManifestEntry[];
}

/** Raised when a manifest file exists but cannot be parsed or validated. */
export class MalformedManifestError extends Error {
	constructor(message: string) {
		super(`Malformed docs manifest: ${message}`);
		this.name = "MalformedManifestError";
	}
}

/** Path to the manifest file inside a `docs/` directory. */
export function docsManifestPath(docsDir: string): string {
	return join(docsDir, MANIFEST_FILENAME);
}

/** A fresh, empty manifest. */
export function emptyDocsManifest(): DocsManifest {
	return { version: DOCS_MANIFEST_VERSION, documents: [] };
}

function isManifestEntry(value: unknown): value is DocsManifestEntry {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Record<string, unknown>;
	return (
		typeof e.documentId === "string" &&
		typeof e.title === "string" &&
		typeof e.localPath === "string" &&
		typeof e.source === "string" &&
		typeof e.hydratedAt === "string" &&
		typeof e.runId === "string"
	);
}

function parseManifest(raw: string): DocsManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new MalformedManifestError(
			`invalid JSON (${(cause as Error).message})`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new MalformedManifestError("expected a JSON object");
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== DOCS_MANIFEST_VERSION) {
		throw new MalformedManifestError(
			`unsupported version ${JSON.stringify(obj.version)}`,
		);
	}
	if (!Array.isArray(obj.documents)) {
		throw new MalformedManifestError("`documents` must be an array");
	}
	for (const [i, entry] of obj.documents.entries()) {
		if (!isManifestEntry(entry)) {
			throw new MalformedManifestError(`invalid entry at index ${i}`);
		}
	}
	return { version: DOCS_MANIFEST_VERSION, documents: obj.documents };
}

/**
 * Read the manifest from a `docs/` directory. Returns an empty manifest if the
 * file does not exist yet (a missing manifest is a valid empty working set).
 * Throws {@link MalformedManifestError} if the file exists but is unparseable.
 */
export function readDocsManifest(docsDir: string): DocsManifest {
	let raw: string;
	try {
		raw = readFileSync(docsManifestPath(docsDir), "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyDocsManifest();
		}
		throw cause;
	}
	return parseManifest(raw);
}

/**
 * Atomically write a manifest into a `docs/` directory. Writes a sibling temp
 * file and renames it into place so a partial write can never be observed as
 * `manifest.json`. The `docs/` directory must already exist.
 */
export function writeDocsManifest(
	docsDir: string,
	manifest: DocsManifest,
): void {
	const target = docsManifestPath(docsDir);
	const tmp = `${target}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		renameSync(tmp, target);
	} catch (cause) {
		// Don't leave a partial temp file behind on a failed write (e.g. ENOSPC).
		rmSync(tmp, { force: true });
		throw cause;
	}
}
