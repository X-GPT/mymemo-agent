import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDocsManifest } from "./docs-manifest";

let docsDir: string;

beforeEach(() => {
	docsDir = mkdtempSync(join(tmpdir(), "chat-api-docs-manifest-test-"));
});

afterEach(() => {
	rmSync(docsDir, { recursive: true, force: true });
});

describe("writeDocsManifest concurrency", () => {
	// chat-api does not serialize turns per conversation, so two concurrent turns
	// can call writeDocsManifest against the same durable `docs/` dir at once.
	// This proves the final manifest.json is always one writer's complete output,
	// never a torn or byte-mixed file (which a shared fixed temp name would cause).
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
