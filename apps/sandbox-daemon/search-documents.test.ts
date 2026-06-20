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
import { readDocsManifest, upsertDocsManifestEntry } from "./docs-manifest";
import {
	documentFilename,
	GATEWAY_SOURCE,
	GatewayDocumentError,
	MAX_HYDRATED_DOCUMENTS,
	type SearchDocumentsDeps,
	searchAndHydrate,
} from "./search-documents";

let docsDir: string;

beforeEach(() => {
	docsDir = mkdtempSync(join(tmpdir(), "search-documents-test-"));
});

afterEach(() => {
	rmSync(docsDir, { recursive: true, force: true });
});

const FIXED_NOW = new Date("2026-06-18T00:00:00.000Z");

/**
 * A fake gateway: routes by URL path to a queued search response and a
 * documentId → fetch response map. Records every call so tests can assert what
 * was (and wasn't) requested.
 */
function fakeGateway(opts: {
	search?: { status?: number; body?: unknown };
	fetchByDoc?: Record<string, { status?: number; body?: unknown }>;
	throwOn?: "search" | "fetch";
}): { fetchImpl: typeof fetch; calls: { url: string; body: unknown }[] } {
	const calls: { url: string; body: unknown }[] = [];
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url: u, body });
		if (u.endsWith("/v1/documents/search")) {
			if (opts.throwOn === "search") throw new Error("connection refused");
			const r = opts.search ?? { body: { documents: [] } };
			return new Response(JSON.stringify(r.body ?? {}), {
				status: r.status ?? 200,
			});
		}
		if (u.endsWith("/v1/documents/fetch")) {
			if (opts.throwOn === "fetch") throw new Error("connection refused");
			const docId = body?.documentId as string;
			const r = opts.fetchByDoc?.[docId] ?? { status: 404, body: {} };
			return new Response(JSON.stringify(r.body ?? {}), {
				status: r.status ?? 200,
			});
		}
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function deps(fetchImpl: typeof fetch): SearchDocumentsDeps {
	return {
		gatewayUrl: "https://gateway.example",
		token: "doc-token",
		docsDir,
		runId: "run-1",
		fetchImpl,
		now: () => FIXED_NOW,
	};
}

describe("documentFilename", () => {
	it("keeps a clean id as a readable .md filename", () => {
		expect(documentFilename("abc-123")).toBe("abc-123.md");
		expect(documentFilename("doc-ml-intro")).toBe("doc-ml-intro.md");
	});

	it("sanitizes path-unsafe characters and disambiguates with a hash suffix", () => {
		// A rewritten id can't keep its raw name (it would traverse / collide), so
		// it gets `<safe>.<8-hex>.md`.
		expect(documentFilename("../../etc/passwd")).toMatch(
			/^______etc_passwd\.[0-9a-f]{8}\.md$/,
		);
		expect(documentFilename("a/b\\c")).toMatch(/^a_b_c\.[0-9a-f]{8}\.md$/);
		expect(documentFilename("")).toMatch(/^document\.[0-9a-f]{8}\.md$/);
	});

	it("never maps two distinct ids to the same filename", () => {
		// `a/b` and `a.b` both sanitize to `a_b`; the hash of the original id keeps
		// their files distinct. A clean `a_b` also stays distinct from both.
		expect(documentFilename("a/b")).not.toBe(documentFilename("a.b"));
		expect(documentFilename("a/b")).not.toBe(documentFilename("a_b"));
	});
});

describe("searchAndHydrate", () => {
	it("returns an empty result and fetches nothing when there are no matches", async () => {
		const { fetchImpl, calls } = fakeGateway({
			search: { body: { documents: [] } },
		});
		const results = await searchAndHydrate("nothing", deps(fetchImpl));

		expect(results).toEqual([]);
		// Searched once, never fetched.
		expect(calls.map((c) => c.url)).toEqual([
			"https://gateway.example/v1/documents/search",
		]);
		// No manifest is written for an empty search.
		expect(existsSync(join(docsDir, "manifest.json"))).toBe(false);
	});

	it("hydrates matches to disk, writes the manifest, and returns local paths", async () => {
		const { fetchImpl, calls } = fakeGateway({
			search: {
				body: {
					documents: [
						{
							passageId: "p1",
							documentId: "d1",
							title: "Doc One",
							snippet: "snippet one",
						},
						{
							passageId: "p2",
							documentId: "d2",
							title: "Doc Two",
							snippet: "snippet two",
						},
					],
				},
			},
			fetchByDoc: {
				d1: { body: { documentId: "d1", title: "Doc One", content: "BODY1" } },
				d2: { body: { documentId: "d2", title: "Doc Two", content: "BODY2" } },
			},
		});

		const results = await searchAndHydrate("query", deps(fetchImpl));

		expect(results).toEqual([
			{
				documentId: "d1",
				source: GATEWAY_SOURCE,
				title: "Doc One",
				snippet: "snippet one",
				passageId: "p1",
				localPath: join(docsDir, "d1.md"),
			},
			{
				documentId: "d2",
				source: GATEWAY_SOURCE,
				title: "Doc Two",
				snippet: "snippet two",
				passageId: "p2",
				localPath: join(docsDir, "d2.md"),
			},
		]);

		// Files were written with the fetched content...
		expect(readFileSync(join(docsDir, "d1.md"), "utf8")).toBe("BODY1");
		expect(readFileSync(join(docsDir, "d2.md"), "utf8")).toBe("BODY2");

		// ...and the manifest records both, attributed to the run.
		const manifest = readDocsManifest(docsDir);
		expect(manifest.documents).toEqual([
			{
				documentId: "d1",
				title: "Doc One",
				localPath: "d1.md",
				source: GATEWAY_SOURCE,
				hydratedAt: FIXED_NOW.toISOString(),
				runId: "run-1",
			},
			{
				documentId: "d2",
				title: "Doc Two",
				localPath: "d2.md",
				source: GATEWAY_SOURCE,
				hydratedAt: FIXED_NOW.toISOString(),
				runId: "run-1",
			},
		]);

		// search + one fetch per document.
		expect(calls.filter((c) => c.url.endsWith("/fetch")).length).toBe(2);
	});

	it("reports already-hydrated documents as already_local without re-fetching", async () => {
		// Pre-seed the manifest AND the file on disk, as a prior run would have.
		upsertDocsManifestEntry(docsDir, {
			documentId: "d1",
			title: "Old Title",
			localPath: "d1.md",
			source: GATEWAY_SOURCE,
			hydratedAt: "2026-06-01T00:00:00.000Z",
			runId: "run-0",
		});
		writeFileSync(join(docsDir, "d1.md"), "cached body", "utf8");

		const { fetchImpl, calls } = fakeGateway({
			search: {
				body: {
					documents: [
						{
							passageId: "p1",
							documentId: "d1",
							title: "Fresh Title",
							snippet: "fresh snippet",
						},
					],
				},
			},
		});

		const results = await searchAndHydrate("query", deps(fetchImpl));

		expect(results).toEqual([
			{
				documentId: "d1",
				source: "already_local",
				// Title prefers the fresh search hit; localPath points at the cached file.
				title: "Fresh Title",
				snippet: "fresh snippet",
				passageId: "p1",
				localPath: join(docsDir, "d1.md"),
			},
		]);
		// Never fetched — the document was already local.
		expect(calls.some((c) => c.url.endsWith("/fetch"))).toBe(false);
	});

	it("re-fetches when a manifest entry's file is missing on disk", async () => {
		// Manifest says d1 is hydrated, but the file is gone (deleted, or a
		// manifest restored ahead of its blobs). The stale entry must not be
		// trusted — re-fetch instead of handing back a path Read would fail on.
		upsertDocsManifestEntry(docsDir, {
			documentId: "d1",
			title: "Stale Title",
			localPath: "d1.md",
			source: GATEWAY_SOURCE,
			hydratedAt: "2026-06-01T00:00:00.000Z",
			runId: "run-0",
		});
		// Note: no d1.md file written.

		const { fetchImpl, calls } = fakeGateway({
			search: {
				body: {
					documents: [
						{ passageId: "p1", documentId: "d1", title: "T1", snippet: "s1" },
					],
				},
			},
			fetchByDoc: {
				d1: { body: { documentId: "d1", title: "T1", content: "FRESH" } },
			},
		});

		const results = await searchAndHydrate("query", deps(fetchImpl));

		// Re-hydrated from the gateway, not reported already_local.
		expect(results[0]).toMatchObject({
			documentId: "d1",
			source: GATEWAY_SOURCE,
		});
		expect(calls.some((c) => c.url.endsWith("/fetch"))).toBe(true);
		expect(readFileSync(join(docsDir, "d1.md"), "utf8")).toBe("FRESH");
	});

	it("throws GatewayDocumentError on a non-OK search response", async () => {
		const { fetchImpl } = fakeGateway({ search: { status: 502, body: {} } });
		await expect(searchAndHydrate("q", deps(fetchImpl))).rejects.toBeInstanceOf(
			GatewayDocumentError,
		);
	});

	it("throws GatewayDocumentError when the gateway is unreachable", async () => {
		const { fetchImpl } = fakeGateway({ throwOn: "search" });
		await expect(searchAndHydrate("q", deps(fetchImpl))).rejects.toBeInstanceOf(
			GatewayDocumentError,
		);
	});

	it("throws GatewayDocumentError on a 200 with a non-JSON body", async () => {
		// e.g. a proxy/LB returns an HTML error page with status 200.
		const fetchImpl = (async () =>
			new Response("<html>oops</html>", {
				status: 200,
			})) as unknown as typeof fetch;
		await expect(searchAndHydrate("q", deps(fetchImpl))).rejects.toBeInstanceOf(
			GatewayDocumentError,
		);
	});

	it("throws GatewayDocumentError on a non-OK fetch response", async () => {
		const { fetchImpl } = fakeGateway({
			search: {
				body: { documents: [{ documentId: "d1", title: "t", snippet: "s" }] },
			},
			fetchByDoc: { d1: { status: 500, body: {} } },
		});
		await expect(searchAndHydrate("q", deps(fetchImpl))).rejects.toBeInstanceOf(
			GatewayDocumentError,
		);
	});

	it("dedupes passages to distinct documents and caps at MAX_HYDRATED_DOCUMENTS", async () => {
		// Two passages for d1, then more distinct docs than the cap allows.
		const documents = [
			{ documentId: "d1", title: "D1", snippet: "first" },
			{ documentId: "d1", title: "D1", snippet: "second" },
		];
		const fetchByDoc: Record<string, { body: unknown }> = {
			d1: { body: { documentId: "d1", title: "D1", content: "B1" } },
		};
		for (let i = 0; i < MAX_HYDRATED_DOCUMENTS + 3; i++) {
			const id = `x${i}`;
			documents.push({ documentId: id, title: id, snippet: id });
			fetchByDoc[id] = { body: { documentId: id, title: id, content: id } };
		}

		const { fetchImpl, calls } = fakeGateway({
			search: { body: { documents } },
			fetchByDoc,
		});

		const results = await searchAndHydrate("q", deps(fetchImpl));

		// Capped at the limit, no document repeated.
		expect(results.length).toBe(MAX_HYDRATED_DOCUMENTS);
		const ids = results.map((r) => r.documentId);
		expect(new Set(ids).size).toBe(MAX_HYDRATED_DOCUMENTS);
		// d1 kept its first passage's snippet.
		expect(results[0]).toMatchObject({ documentId: "d1", snippet: "first" });
		// Never fetched more than the cap.
		expect(calls.filter((c) => c.url.endsWith("/fetch")).length).toBe(
			MAX_HYDRATED_DOCUMENTS,
		);
	});
});
