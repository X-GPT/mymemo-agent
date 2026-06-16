import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DOCS_MANIFEST_VERSION,
	type DocsManifestEntry,
	docsManifestPath,
	emptyDocsManifest,
	MalformedManifestError,
	readDocsManifest,
	upsertDocsManifestEntry,
	writeDocsManifest,
} from "./docs-manifest";

let docsDir: string;

beforeEach(() => {
	docsDir = mkdtempSync(join(tmpdir(), "docs-manifest-test-"));
});

afterEach(() => {
	rmSync(docsDir, { recursive: true, force: true });
});

function entry(overrides: Partial<DocsManifestEntry> = {}): DocsManifestEntry {
	return {
		documentId: "doc-1",
		title: "First Doc",
		localPath: "doc-1.md",
		source: "kb",
		hydratedAt: "2026-06-16T00:00:00.000Z",
		runId: "run-1",
		...overrides,
	};
}

describe("readDocsManifest", () => {
	it("returns an empty manifest when the file is missing", () => {
		const manifest = readDocsManifest(docsDir);
		expect(manifest).toEqual(emptyDocsManifest());
		expect(manifest.documents).toEqual([]);
		// Reading must not create the file.
		expect(existsSync(docsManifestPath(docsDir))).toBe(false);
	});

	it("reads and preserves an existing manifest", () => {
		const original = emptyDocsManifest();
		original.documents.push(
			entry(),
			entry({ documentId: "doc-2", title: "Second" }),
		);
		writeDocsManifest(docsDir, original);

		const read = readDocsManifest(docsDir);
		expect(read).toEqual(original);
	});

	it("throws on invalid JSON", () => {
		writeFileSync(docsManifestPath(docsDir), "{ not json", "utf8");
		expect(() => readDocsManifest(docsDir)).toThrow(MalformedManifestError);
	});

	it("throws on a non-object root", () => {
		writeFileSync(docsManifestPath(docsDir), "[]", "utf8");
		expect(() => readDocsManifest(docsDir)).toThrow(/expected a JSON object/);
	});

	it("throws on an unsupported version", () => {
		writeFileSync(
			docsManifestPath(docsDir),
			JSON.stringify({ version: 999, documents: [] }),
			"utf8",
		);
		expect(() => readDocsManifest(docsDir)).toThrow(/unsupported version/);
	});

	it("throws when documents is not an array", () => {
		writeFileSync(
			docsManifestPath(docsDir),
			JSON.stringify({ version: DOCS_MANIFEST_VERSION, documents: {} }),
			"utf8",
		);
		expect(() => readDocsManifest(docsDir)).toThrow(
			/`documents` must be an array/,
		);
	});

	it("throws on an entry missing required fields", () => {
		writeFileSync(
			docsManifestPath(docsDir),
			JSON.stringify({
				version: DOCS_MANIFEST_VERSION,
				documents: [{ documentId: "doc-1", title: "no paths" }],
			}),
			"utf8",
		);
		expect(() => readDocsManifest(docsDir)).toThrow(/invalid entry at index 0/);
	});
});

describe("writeDocsManifest", () => {
	it("creates the manifest file when missing", () => {
		expect(existsSync(docsManifestPath(docsDir))).toBe(false);
		writeDocsManifest(docsDir, emptyDocsManifest());
		expect(existsSync(docsManifestPath(docsDir))).toBe(true);
	});

	it("writes pretty-printed JSON that round-trips", () => {
		const manifest = emptyDocsManifest();
		manifest.documents.push(entry());
		writeDocsManifest(docsDir, manifest);

		const raw = readFileSync(docsManifestPath(docsDir), "utf8");
		expect(raw).toContain("\n");
		expect(JSON.parse(raw)).toEqual(manifest);
	});

	it("leaves no temp file behind", () => {
		writeDocsManifest(docsDir, emptyDocsManifest());
		expect(existsSync(`${docsManifestPath(docsDir)}.tmp`)).toBe(false);
	});
});

describe("upsertDocsManifestEntry", () => {
	it("creates the manifest and appends on first write", () => {
		const manifest = upsertDocsManifestEntry(docsDir, entry());
		expect(manifest.documents).toEqual([entry()]);
		expect(readDocsManifest(docsDir)).toEqual(manifest);
	});

	it("replaces an existing entry by documentId without duplicating", () => {
		upsertDocsManifestEntry(docsDir, entry());
		const updated = upsertDocsManifestEntry(
			docsDir,
			entry({
				title: "Updated",
				hydratedAt: "2026-06-17T00:00:00.000Z",
				runId: "run-2",
			}),
		);
		expect(updated.documents).toHaveLength(1);
		expect(updated.documents[0]).toMatchObject({
			documentId: "doc-1",
			title: "Updated",
			runId: "run-2",
		});
	});

	it("preserves other entries when upserting", () => {
		upsertDocsManifestEntry(docsDir, entry());
		const updated = upsertDocsManifestEntry(
			docsDir,
			entry({ documentId: "doc-2" }),
		);
		expect(updated.documents.map((d) => d.documentId).sort()).toEqual([
			"doc-1",
			"doc-2",
		]);
	});
});
