import { describe, expect, it } from "bun:test";
import {
	DocumentAccessError,
	type ScopedDocumentClient,
} from "./document-client";
import {
	DOCS_CACHE_DIRNAME,
	DOCUMENT_TOOL_LIMITS,
	LOAD_TRUNCATION_NOTICE,
	listDocuments,
	loadDocuments,
	searchDocuments,
} from "./document-tools";

/** A scoped client that records every call; `overrides` replace the defaults. */
function client(overrides: Partial<ScopedDocumentClient> = {}) {
	const calls: unknown[] = [];
	const base: ScopedDocumentClient = {
		list: async () => ({ total: 0, documents: [], next: null }),
		search: async () => [],
		fetch: async (documentId) => ({
			documentId,
			title: "T",
			content: "body",
			truncated: false,
		}),
		...overrides,
	};
	return {
		calls,
		list: async (input: Parameters<ScopedDocumentClient["list"]>[0]) => {
			calls.push(input);
			return base.list(input);
		},
		search: async (input: Parameters<ScopedDocumentClient["search"]>[0]) => {
			calls.push(input);
			return base.search(input);
		},
		fetch: async (documentId: string) => {
			calls.push(documentId);
			return base.fetch(documentId);
		},
	};
}

describe("ListDocuments", () => {
	it("caps the page at 20 and round-trips the opaque cursor", async () => {
		const c = client({
			list: async () => ({
				total: 2,
				documents: [],
				next:
					c.calls.length === 1
						? { createdAt: "2026-07-01T12:00:00.000Z", sourceAssetId: "a7" }
						: null,
			}),
		});
		const first = await listDocuments({ limit: 500 }, c);
		if ("isError" in first) throw new Error(first.text);
		expect(typeof first.nextCursor).toBe("string");
		expect(first.nextCursor).not.toContain("a7");
		const second = await listDocuments({ cursor: first.nextCursor ?? "" }, c);
		expect(second).toEqual({ total: 2, documents: [], nextCursor: null });
		expect(c.calls).toEqual([
			{ limit: 20, after: null },
			{
				limit: 20,
				after: { createdAt: "2026-07-01T12:00:00.000Z", sourceAssetId: "a7" },
			},
		]);
	});

	it("rejects malformed, foreign, and oversized cursors before touching the client", async () => {
		const c = client();
		const encode = (v: unknown) =>
			Buffer.from(JSON.stringify(v)).toString("base64url");
		for (const cursor of [
			"",
			"not-a-cursor!",
			encode({
				version: 2,
				createdAt: "2026-07-01T12:00:00.000Z",
				sourceAssetId: "a",
			}),
			encode({ version: 1, createdAt: "nope", sourceAssetId: "a" }),
			encode({
				version: 1,
				createdAt: "2026-07-01T12:00:00.000Z",
				sourceAssetId: "",
			}),
			"x".repeat(4_097),
		]) {
			expect(await listDocuments({ cursor }, c)).toEqual({
				isError: true,
				text: "ListDocuments failed: invalid cursor",
			});
		}
		expect(c.calls).toEqual([]);
	});

	it("maps a client failure to a tool failure", async () => {
		const c = client({
			list: async () => {
				throw new DocumentAccessError("document list failed");
			},
		});
		expect(await listDocuments({}, c)).toEqual({
			isError: true,
			text: "ListDocuments failed: document list failed",
		});
	});
});

describe("SearchDocuments", () => {
	it("trims the query, caps maxResults at 8, and reports an empty result", async () => {
		const c = client();
		expect(
			await searchDocuments({ query: "  margin ", maxResults: 50 }, c),
		).toEqual({
			passages: [],
			message: "No MyMemo document passages matched the query.",
		});
		expect(c.calls).toEqual([{ query: "margin", maxResults: 8 }]);
		expect(await searchDocuments({ query: " " }, c)).toEqual({
			isError: true,
			text: "SearchDocuments requires a non-empty query.",
		});
	});

	it("returns citable passages and maps a client failure", async () => {
		const hit = { passageId: "p1", documentId: "d1", title: "A", snippet: "s" };
		expect(
			await searchDocuments(
				{ query: "x" },
				client({ search: async () => [hit] }),
			),
		).toEqual({ passages: [hit] });
		expect(
			await searchDocuments(
				{ query: "x" },
				client({
					search: async () => {
						throw new DocumentAccessError("document search failed");
					},
				}),
			),
		).toEqual({
			isError: true,
			text: "SearchDocuments failed: document search failed",
		});
	});
});

describe("LoadDocuments", () => {
	function sandbox() {
		const writes: { path: string; content: string }[] = [];
		return {
			writes,
			writeTextFile: async (input: { path: string; content: string }) => {
				writes.push({ path: input.path, content: input.content });
			},
		};
	}
	const workDir = "/vercel/sandbox/cc-conv-1";
	const cache = `${workDir}/${DOCS_CACHE_DIRNAME}`;

	it("writes the body to the cache and returns path and byte count only", async () => {
		const c = client({
			fetch: async (documentId) => ({
				documentId,
				title: "Q4",
				content: "SECRET BODY",
				truncated: false,
			}),
		});
		const s = sandbox();
		const result = await loadDocuments(
			{ documentIds: ["d1", "d1"] },
			{ client: c, sandbox: s, workDir },
		);
		expect(result).toEqual({
			loaded: [
				{
					documentId: "d1",
					title: "Q4",
					path: `${cache}/d1.md`,
					bytes: 11,
					truncated: false,
				},
			],
			errors: [],
		});
		expect(s.writes).toEqual([
			{ path: `${cache}/d1.md`, content: "SECRET BODY" },
		]);
	});

	it("rejects an empty list, more than 10 ids, and unsafe ids before fetching", async () => {
		const c = client();
		const s = sandbox();
		expect(
			await loadDocuments(
				{ documentIds: [] },
				{ client: c, sandbox: s, workDir },
			),
		).toEqual({
			isError: true,
			text: "LoadDocuments requires at least one document id.",
		});
		expect(
			await loadDocuments(
				{
					documentIds: Array.from(
						{ length: DOCUMENT_TOOL_LIMITS.load.maxDocuments + 1 },
						(_, i) => `d${i}`,
					),
				},
				{ client: c, sandbox: s, workDir },
			),
		).toEqual({
			isError: true,
			text: "LoadDocuments accepts at most 10 document ids per call.",
		});
		expect(
			await loadDocuments(
				{ documentIds: ["../escape"] },
				{ client: c, sandbox: s, workDir },
			),
		).toEqual({
			loaded: [],
			errors: [
				{
					documentId: "../escape",
					error: "document id is not a valid identifier.",
				},
			],
		});
		expect(c.calls).toEqual([]);
		expect(s.writes).toEqual([]);
	});

	it("clips each document to 256 KiB and the call to 1 MiB, marking truncation on disk", async () => {
		const { perDocumentMaxBytes, perCallMaxBytes } = DOCUMENT_TOOL_LIMITS.load;
		const c = client({
			fetch: async (documentId) => ({
				documentId,
				title: "T",
				content: "A".repeat(perDocumentMaxBytes + 1),
				truncated: false,
			}),
		});
		const s = sandbox();
		const ids = ["a", "b", "c", "d", "e"];
		const result = await loadDocuments(
			{ documentIds: ids },
			{ client: c, sandbox: s, workDir },
		);
		if ("isError" in result) throw new Error(result.text);
		// 4 × 256 KiB fills the call budget; the fifth is never fetched.
		expect(
			result.loaded.map((d) => [d.documentId, d.bytes, d.truncated]),
		).toEqual(ids.slice(0, 4).map((id) => [id, perDocumentMaxBytes, true]));
		expect(result.errors).toEqual([
			{
				documentId: "e",
				error: "per-call byte budget exhausted; load fewer documents.",
			},
		]);
		expect(c.calls).toEqual(ids.slice(0, 4));
		expect(perDocumentMaxBytes * 4).toBe(perCallMaxBytes);
		expect(s.writes[0]?.content).toBe(
			"A".repeat(perDocumentMaxBytes) + LOAD_TRUNCATION_NOTICE,
		);
	});

	it("reports scope and write failures per document and keeps going", async () => {
		const c = client({
			fetch: async (documentId) => {
				if (documentId === "bad") {
					throw new DocumentAccessError(
						"document is not available in this conversation's scope",
					);
				}
				return {
					documentId,
					title: "T",
					content: "ok",
					truncated: documentId === "clipped",
				};
			},
		});
		const s = sandbox();
		s.writeTextFile = async (input) => {
			if (input.path.endsWith("nospace.md")) throw new Error("ENOSPC");
			s.writes.push({ path: input.path, content: input.content });
		};
		const result = await loadDocuments(
			{ documentIds: ["bad", "nospace", "clipped"] },
			{ client: c, sandbox: s, workDir },
		);
		expect(result).toEqual({
			loaded: [
				{
					documentId: "clipped",
					title: "T",
					path: `${cache}/clipped.md`,
					bytes: 2,
					truncated: true,
				},
			],
			errors: [
				{
					documentId: "bad",
					error: "document is not available in this conversation's scope",
				},
				{ documentId: "nospace", error: "failed to cache document: ENOSPC" },
			],
		});
		expect(s.writes).toEqual([
			{ path: `${cache}/clipped.md`, content: `ok${LOAD_TRUNCATION_NOTICE}` },
		]);
	});
});
