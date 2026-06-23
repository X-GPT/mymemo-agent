/**
 * Docs manifest. Each conversation workspace tracks the documents hydrated into
 * its `docs/` directory in a single `manifest.json`:
 *
 *   /workspace/conversations/{conversationId}/docs/
 *     manifest.json   <- this file
 *     {hydrated documents...}
 *
 * The manifest is the durable record of what the working set contains: for each
 * hydrated document it stores its id, title, local path, source, the time it was
 * hydrated or last updated, and the run that caused the hydration.
 *
 * Two correctness properties matter here:
 *   - Reads fail closed. A manifest that is present but unparseable is a signal
 *     that something corrupted the workspace; we throw rather than silently
 *     treating it as empty and overwriting whatever was there.
 *   - Writes are atomic. We write to a temp file in the same directory and
 *     rename it into place, so a reader never observes a half-written
 *     `manifest.json`: it sees either the old file or the complete new one.
 *     (This guards against torn writes, not against power-loss durability —
 *     the bytes are not fsync'd before the rename.)
 */

import { randomBytes } from "node:crypto";
import {
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Current on-disk schema version. Bumped only on a breaking format change. */
export const DOCS_MANIFEST_VERSION = 1;

const MANIFEST_FILENAME = "manifest.json";

/**
 * A temp file older than this is treated as abandoned (its writer crashed before
 * the rename) and reclaimed on the next write. Comfortably longer than any real
 * manifest write, so a concurrent live writer's in-flight temp is never swept.
 */
const STALE_TEMP_MS = 60_000;

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

/** Path to the manifest file inside a conversation's `docs/` directory. */
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
 * Read the manifest from a conversation's `docs/` directory.
 *
 * Returns an empty manifest if the file does not exist yet (a missing manifest
 * is a valid empty working set). Throws {@link MalformedManifestError} if the
 * file exists but is unparseable, so callers fail closed instead of clobbering
 * a corrupt-but-meaningful file.
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
 * Best-effort removal of temp files orphaned by a writer that crashed between
 * the write and the rename. Each write uses a unique temp name (so concurrent
 * writers never collide), which means a hard crash leaks its temp file and
 * nothing else would ever reclaim it. Only temps older than {@link
 * STALE_TEMP_MS} are removed, so a concurrent live writer's fresh temp is left
 * alone. Failures are ignored: this is opportunistic cleanup, not correctness.
 */
function sweepStaleTemps(docsDir: string): void {
	const prefix = `${MANIFEST_FILENAME}.`;
	let names: string[];
	try {
		names = readdirSync(docsDir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		const path = join(docsDir, name);
		try {
			if (now - statSync(path).mtimeMs > STALE_TEMP_MS) {
				rmSync(path, { force: true });
			}
		} catch {
			// Raced with another writer renaming/removing it — ignore.
		}
	}
}

/**
 * Atomically write a manifest into a conversation's `docs/` directory. Writes a
 * sibling temp file and renames it into place so a partial write can never be
 * observed as `manifest.json`. The `docs/` directory must already exist.
 *
 * The temp file name is unique per write (pid + random token) so two writers
 * targeting the same `docs/` dir never share a temp path: each writes its own
 * temp file and renames it into place atomically, so the final `manifest.json`
 * is always one writer's complete output — never a byte-mix of both. (A fixed
 * temp name would let concurrent writers truncate and clobber each other's
 * temp bytes before the rename.)
 *
 * The guarantee is corruption-freedom only: writes are last-writer-wins, not a
 * merge. A caller that reads the manifest, mutates it, and writes it back (see
 * {@link upsertDocsManifestEntry}) can still drop a concurrent writer's change;
 * such read-modify-write callers must serialize themselves.
 */
export function writeDocsManifest(
	docsDir: string,
	manifest: DocsManifest,
): void {
	sweepStaleTemps(docsDir);
	const target = docsManifestPath(docsDir);
	const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		renameSync(tmp, target);
	} catch (cause) {
		// Don't leave a partial temp file behind on a failed write (e.g. ENOSPC).
		rmSync(tmp, { force: true });
		throw cause;
	}
}

/**
 * Read the manifest, insert or replace the entry for `entry.documentId`, and
 * write it back atomically. Re-hydrating a document updates its existing entry
 * in place rather than appending a duplicate. Returns the updated manifest.
 *
 * This is a read-modify-write, so it is only safe under a single writer: the
 * daemon's per-turn lock serializes turns within a sandbox. Two concurrent
 * upserts would each read the same base and one would overwrite the other (a
 * lost update); the atomic write in {@link writeDocsManifest} prevents
 * corruption but not that.
 */
export function upsertDocsManifestEntry(
	docsDir: string,
	entry: DocsManifestEntry,
): DocsManifest {
	const manifest = readDocsManifest(docsDir);
	const documents = manifest.documents.filter(
		(d) => d.documentId !== entry.documentId,
	);
	documents.push(entry);
	const updated: DocsManifest = { version: DOCS_MANIFEST_VERSION, documents };
	writeDocsManifest(docsDir, updated);
	return updated;
}
