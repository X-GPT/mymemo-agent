import { describe, expect, it } from "bun:test";
import type { DocumentAccessEvent } from "./document-access-log";
import {
	createScopedDocumentClient,
	DocumentAccessError,
	type FrozenScope,
	type HarnessToolLogger,
	type KbDb,
	parseFrozenScope,
} from "./document-client";

interface Call {
	text: string;
	params: unknown[];
}

/** Records every KB query; `respond` answers by SQL shape. */
function fakeKb(respond: (text: string) => unknown[] = () => []) {
	const calls: Call[] = [];
	const db: KbDb = {
		async query<T>(text: string, params: unknown[] = []) {
			calls.push({ text, params });
			return respond(text) as T[];
		},
	};
	return { db, calls };
}

const binding = {
	userId: "member-1",
	conversationId: "conv-1",
	turnId: "turn-1",
};
const isSearch = (c: Call) => c.text.includes("ts_rank_cd");
const isList = (c: Call) => c.text.includes("jsonb_agg");
const isFetch = (c: Call) => c.text.includes("canonical_markdown");
const isResolve = (c: Call) => c.text.includes("content_asset");
const OUT_OF_SCOPE = "document is not available in this conversation's scope";

function makeClient(
	scope: FrozenScope,
	respond?: (text: string) => unknown[],
	logger: HarnessToolLogger = { info() {}, error() {} },
) {
	const kb = fakeKb(respond);
	const audits: DocumentAccessEvent[] = [];
	const client = createScopedDocumentClient({
		kb: kb.db,
		audit: {
			async record(event) {
				audits.push(event);
			},
		},
		logger,
		binding,
		scope,
	});
	return { client, calls: kb.calls, audits };
}

describe("parseFrozenScope", () => {
	it("parses the three shapes and rejects a scoped row missing its id", () => {
		expect(
			parseFrozenScope({
				scope: "general",
				collectionId: null,
				summaryId: null,
			}),
		).toEqual({ type: "general" });
		expect(
			parseFrozenScope({
				scope: "collection",
				collectionId: "c1",
				summaryId: null,
			}),
		).toEqual({ type: "collection", collectionId: "c1" });
		expect(
			parseFrozenScope({
				scope: "document",
				collectionId: null,
				summaryId: "12",
			}),
		).toEqual({ type: "document", summaryId: "12" });
		expect(() =>
			parseFrozenScope({
				scope: "collection",
				collectionId: null,
				summaryId: null,
			}),
		).toThrow(/collection/);
		expect(() =>
			parseFrozenScope({
				scope: "document",
				collectionId: null,
				summaryId: null,
			}),
		).toThrow(/document/);
	});
});

describe("scope filtering", () => {
	it("general: pins the user's workspace with no narrowing filter", async () => {
		const { client, calls } = makeClient({ type: "general" });
		await client.search({ query: "hello", maxResults: 8 });
		await client.list({ limit: 5, after: null });
		const search = calls.find(isSearch);
		expect(search?.params).toEqual(["member-1", "hello", 8]);
		expect(search?.text).not.toContain("passage_collection");
		expect(search?.text).not.toContain("document_id IN");
		expect(calls.find(isList)?.params).toEqual(["member-1", 6]);
	});

	it("collection: narrows search, list, and fetch to the frozen collection", async () => {
		const { client, calls } = makeClient(
			{ type: "collection", collectionId: "coll-7" },
			(text) =>
				text.includes("passage_collection") && !isSearch({ text, params: [] })
					? [{ "?column?": 1 }]
					: isFetch({ text, params: [] })
						? [
								{
									document_id: "d1",
									title: "T",
									content: "c",
									content_length: 1,
								},
							]
						: [],
		);
		await client.search({ query: "hello", maxResults: 8 });
		await client.list({
			limit: 5,
			after: { createdAt: "2026-07-10T12:00:00.000Z", sourceAssetId: "a1" },
		});
		expect((await client.fetch("d1")).documentId).toBe("d1");
		const search = calls.find(isSearch);
		expect(search?.text).toContain("compat_str_id");
		expect(search?.params).toContain("coll-7");
		expect(calls.find(isList)?.params).toEqual([
			"member-1",
			"coll-7",
			"2026-07-10T12:00:00.000Z",
			"a1",
			6,
		]);
		const membership = calls.find((c) =>
			c.text.trimStart().startsWith("SELECT 1"),
		);
		expect(membership?.params).toEqual(["coll-7", "member-1", "d1"]);
	});

	it("collection: rejects a document outside the collection before any fetch", async () => {
		const { client, calls, audits } = makeClient({
			type: "collection",
			collectionId: "coll-7",
		});
		await expect(client.fetch("d1")).rejects.toThrow(OUT_OF_SCOPE);
		expect(calls.find(isFetch)).toBeUndefined();
		expect(audits).toEqual([]);
	});

	it("document: resolves the summaryId and pins every query to that document", async () => {
		const { client, calls } = makeClient(
			{ type: "document", summaryId: "12345" },
			(text) =>
				isResolve({ text, params: [] })
					? [{ kb_document_id: "kb-9" }]
					: isFetch({ text, params: [] })
						? [
								{
									document_id: "kb-9",
									title: "T",
									content: "c",
									content_length: 1,
								},
							]
						: [],
		);
		await client.search({ query: "hello", maxResults: 8 });
		expect(calls.find(isResolve)?.params).toEqual(["12345", "member-1"]);
		const search = calls.find(isSearch);
		expect(search?.text).toContain("document_id IN");
		expect(search?.params).toContain("kb-9");
		await client.list({ limit: 5, after: null });
		expect(calls.find(isList)?.params).toEqual(["member-1", "kb-9", 6]);
		expect((await client.fetch("kb-9")).documentId).toBe("kb-9");
		await expect(client.fetch("other")).rejects.toThrow(OUT_OF_SCOPE);
	});

	it("document: an unresolvable summaryId fails closed — empty, audited, no KB query", async () => {
		const { client, calls, audits } = makeClient({
			type: "document",
			summaryId: "not-numeric",
		});
		expect(await client.search({ query: "hello", maxResults: 8 })).toEqual([]);
		expect(await client.list({ limit: 5, after: null })).toEqual({
			total: 0,
			documents: [],
			next: null,
		});
		await expect(client.fetch("d1")).rejects.toThrow(OUT_OF_SCOPE);
		expect(calls).toEqual([]);
		expect(
			audits.map((a) => [a.operation, a.documentIds, a.resultCount]),
		).toEqual([
			["search", [], 0],
			["list", [], 0],
		]);
	});

	it("an unknown id gets the same message as an out-of-scope one", async () => {
		const { client } = makeClient({ type: "general" });
		await expect(client.fetch("ghost")).rejects.toThrow(OUT_OF_SCOPE);
	});
});

describe("audit", () => {
	it("writes one row per call carrying the turn binding, scope, and returned ids", async () => {
		const { client, audits } = makeClient(
			{ type: "collection", collectionId: "coll-7" },
			(text) =>
				isSearch({ text, params: [] })
					? [
							{ passage_id: "p1", document_id: "d1", title: "A", snippet: "s" },
							{ passage_id: "p2", document_id: "d2", title: "B", snippet: "s" },
							{ passage_id: "p3", document_id: "d1", title: "A", snippet: "s" },
						]
					: isList({ text, params: [] })
						? [
								{
									total: 42,
									documents: [
										{
											documentId: "d3",
											sourceAssetId: "a3",
											title: "N",
											sourceType: "pdf",
											language: "en",
											createdAt: "2026-07-10T12:00:00.000Z",
										},
									],
								},
							]
						: text.includes("passage_collection")
							? [{ "?column?": 1 }]
							: isFetch({ text, params: [] })
								? [
										{
											document_id: "d1",
											title: "T",
											content: "c",
											content_length: 1,
										},
									]
								: [],
		);
		await client.search({ query: "hello", maxResults: 8 });
		await client.list({ limit: 20, after: null });
		await client.fetch("d1");
		const common = {
			turnId: "turn-1",
			conversationId: "conv-1",
			userId: "member-1",
			scopeType: "collection",
			scopeId: "coll-7",
		} as const;
		expect(audits).toEqual([
			{
				...common,
				operation: "search",
				query: "hello",
				documentIds: ["d1", "d2"],
				resultCount: 3,
			},
			{
				...common,
				operation: "list",
				query: null,
				documentIds: ["d3"],
				resultCount: 42,
			},
			{
				...common,
				operation: "load",
				query: null,
				documentIds: ["d1"],
				resultCount: 1,
			},
		]);
	});
});

describe("bounded errors", () => {
	const leaky = new Error(
		'syntax error in "SELECT" while connected to postgresql://reader:kb-secret@kb/mymemo_kb',
	);

	it("reduces a KB or audit failure to a fixed message and logs the cause", async () => {
		const logged: unknown[] = [];
		const { client } = makeClient(
			{ type: "general" },
			() => {
				throw leaky;
			},
			{
				info() {},
				error: (obj: object) => {
					logged.push(obj);
				},
			},
		);
		const failures: [Promise<unknown>, string][] = [
			[client.search({ query: "x", maxResults: 8 }), "document search failed"],
			[client.list({ limit: 1, after: null }), "document list failed"],
			[client.fetch("d1"), "document fetch failed"],
		];
		for (const [promise, message] of failures) {
			const error: unknown = await promise.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(DocumentAccessError);
			expect((error as Error).message).toBe(message);
		}
		expect(logged).toHaveLength(3);
		expect(JSON.stringify(logged[0])).not.toContain("kb-secret");
	});

	it("fails closed when the audit write fails", async () => {
		const kb = fakeKb();
		const client = createScopedDocumentClient({
			kb: kb.db,
			audit: {
				async record() {
					throw leaky;
				},
			},
			logger: { info() {}, error() {} },
			binding,
			scope: { type: "general" },
		});
		await expect(client.search({ query: "x", maxResults: 8 })).rejects.toThrow(
			"document search failed",
		);
	});
});
