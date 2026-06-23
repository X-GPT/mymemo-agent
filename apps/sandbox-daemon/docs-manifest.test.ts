import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
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
		const leftovers = readdirSync(docsDir).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("sweeps stale orphan temp files but spares fresh ones", () => {
		const target = docsManifestPath(docsDir);
		// A temp orphaned by a crashed writer (old) and one a concurrent live
		// writer is mid-write on (fresh).
		const stale = `${target}.111.deadbeef.tmp`;
		const fresh = `${target}.222.cafef00d.tmp`;
		writeFileSync(stale, "orphan", "utf8");
		writeFileSync(fresh, "in-flight", "utf8");
		const longAgo = new Date(Date.now() - 10 * 60_000);
		utimesSync(stale, longAgo, longAgo);

		writeDocsManifest(docsDir, emptyDocsManifest());

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});
});

describe("writeDocsManifest concurrency", () => {
	it("concurrent writers never produce a torn or byte-mixed manifest", async () => {
		const WRITERS = 8;
		// A shared fixed temp name makes concurrent writers collide on one path:
		// they truncate/clobber each other's in-flight bytes and their renames
		// race (one writer renames the shared temp away, the next gets ENOENT).
		// The payload spans several pages and each writer loops a few times to
		// widen that window; the unique-temp fix makes every run pass regardless.
		const ENTRIES = 800;
		const ITERATIONS = 4;
		const modulePath = join(import.meta.dir, "docs-manifest.ts");

		// Each subprocess repeatedly writes a full manifest of ENTRIES entries,
		// all tagged with its own writer id, into the SAME docs dir at once. With
		// a unique temp name per write the final manifest.json is always one
		// writer's complete output; a shared fixed temp name lets the writers
		// clobber each other's temp bytes and produce a torn/byte-mixed file.
		const script = `
			const { writeDocsManifest, DOCS_MANIFEST_VERSION } = await import(process.env.MODULE_PATH);
			const id = process.env.WRITER_ID;
			const count = Number(process.env.ENTRY_COUNT);
			const iterations = Number(process.env.ITERATIONS);
			const documents = Array.from({ length: count }, (_, i) => ({
				documentId: \`doc-\${id}-\${i}\`,
				title: \`Doc \${i} from writer \${id} \${"x".repeat(64)}\`,
				localPath: \`doc-\${id}-\${i}.md\`,
				source: "kb",
				hydratedAt: "2026-06-17T00:00:00.000Z",
				runId: \`writer-\${id}\`,
			}));
			const manifest = { version: DOCS_MANIFEST_VERSION, documents };
			for (let n = 0; n < iterations; n++) {
				writeDocsManifest(process.env.DOCS_DIR, manifest);
			}
		`;

		const procs = Array.from({ length: WRITERS }, (_, id) =>
			Bun.spawn(["bun", "-e", script], {
				env: {
					...process.env,
					MODULE_PATH: modulePath,
					DOCS_DIR: docsDir,
					WRITER_ID: String(id),
					ENTRY_COUNT: String(ENTRIES),
					ITERATIONS: String(ITERATIONS),
				},
			}),
		);
		const codes = await Promise.all(procs.map((p) => p.exited));
		expect(codes).toEqual(Array.from({ length: WRITERS }, () => 0));

		// readDocsManifest throws on unparseable JSON, so a passing read already
		// proves the file is valid and complete (fail-closed).
		const manifest = readDocsManifest(docsDir);
		expect(manifest.documents).toHaveLength(ENTRIES);

		// Every entry must come from a single writer — no interleaving.
		const writers = new Set(manifest.documents.map((d) => d.runId));
		expect(writers.size).toBe(1);

		// No writer left a temp file behind.
		const leftovers = readdirSync(docsDir).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	}, 30_000);
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
