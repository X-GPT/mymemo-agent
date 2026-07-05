import { beforeEach, describe, expect, it } from "bun:test";
import type { WorkerLogger } from "../logger";
import {
	createDocumentSearch,
	createScopedDocumentQueryClient,
} from "./client";
import type { Db } from "./db";
import { DocumentQueryError, DocumentScopeError } from "./errors";

const noopLogger: WorkerLogger = {
	info() {},
	warn() {},
	error() {},
};

// Fake Db: records every query and replies via a per-test responder keyed off
// the SQL, so scope filters and audit rows are asserted without live Postgres.
interface Call {
	text: string;
	params: unknown[];
}

function makeFakeDb() {
	const calls: Call[] = [];
	let responder: (text: string, params: unknown[]) => unknown[] = () => [];
	const db: Db = {
		async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
			calls.push({ text, params });
			return responder(text, params) as T[];
		},
	};
	return {
		db,
		calls,
		respond(fn: (text: string, params: unknown[]) => unknown[]) {
			responder = fn;
		},
	};
}

const binding = {
	userId: "member-1",
	conversationId: "conv-1",
	runId: "run-1",
};

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected promise to reject");
}

const isSearch = (c: Call) => c.text.includes("ts_rank_cd");
const isAuditInsert = (c: Call) =>
	/insert into document_access_events/i.test(c.text);

let kb: ReturnType<typeof makeFakeDb>;
let agent: ReturnType<typeof makeFakeDb>;
let client: ReturnType<typeof createScopedDocumentQueryClient>;

beforeEach(() => {
	kb = makeFakeDb();
	agent = makeFakeDb();
	client = createScopedDocumentQueryClient({
		kbDb: kb.db,
		agentDb: agent.db,
		logger: noopLogger,
	});
});

describe("searchDocuments — scope-derived query filters", () => {
	it("general scope: searches only the user's workspace, no narrowing filters", async () => {
		kb.respond((text) =>
			isSearch({ text, params: [] })
				? [
						{
							passage_id: "p1",
							document_id: "d1",
							title: "Doc one",
							snippet: "hello world",
						},
					]
				: [],
		);

		const result = await client.searchDocuments({
			binding,
			scope: { type: "general" },
			query: "hello",
		});

		expect(result.passages).toEqual([
			{
				passageId: "p1",
				documentId: "d1",
				title: "Doc one",
				snippet: "hello world",
			},
		]);
		const search = kb.calls.find(isSearch);
		expect(search).toBeDefined();
		expect(search?.params[0]).toBe("member-1");
		expect(search?.params[1]).toBe("hello");
		expect(search?.text).not.toContain("passage_collection");
		expect(search?.text).not.toContain("document_id IN");
	});

	it("collection scope: narrows the search to the frozen collection", async () => {
		await client.searchDocuments({
			binding,
			scope: { type: "collection", collectionId: "coll-7" },
			query: "hello",
		});

		const search = kb.calls.find(isSearch);
		expect(search?.text).toContain("passage_collection");
		expect(search?.text).toContain("compat_str_id");
		expect(search?.params).toContain("coll-7");
	});

	it("document scope: resolves the summaryId and pins the search to that document", async () => {
		kb.respond((text) =>
			text.includes("content_asset") ? [{ kb_document_id: "kb-doc-9" }] : [],
		);

		await client.searchDocuments({
			binding,
			scope: { type: "document", summaryId: "12345" },
			query: "hello",
		});

		const resolve = kb.calls.find((c) => c.text.includes("content_asset"));
		expect(resolve?.params).toEqual(["12345", "member-1"]);
		const search = kb.calls.find(isSearch);
		expect(search?.text).toContain("document_id IN");
		expect(search?.params).toContain("kb-doc-9");
	});

	it("document scope that does not resolve fails closed: empty result, no passage query, audited", async () => {
		kb.respond(() => []); // summaryId resolves to nothing

		const result = await client.searchDocuments({
			binding,
			scope: { type: "document", summaryId: "12345" },
			query: "hello",
		});

		expect(result.passages).toEqual([]);
		expect(kb.calls.find(isSearch)).toBeUndefined();
		const audits = agent.calls.filter(isAuditInsert);
		expect(audits).toHaveLength(1);
		expect(audits[0]?.params).toEqual([
			"run-1",
			"conv-1",
			"member-1",
			"document",
			"12345",
			"hello",
			[],
		]);
	});
});

describe("searchDocuments — result bounds", () => {
	const searchLimit = () => {
		const search = kb.calls.find(isSearch);
		return search?.params?.[search.params.length - 1];
	};

	it("defaults to a small result limit", async () => {
		await client.searchDocuments({
			binding,
			scope: { type: "general" },
			query: "hello",
		});
		expect(searchLimit()).toBe(8);
	});

	it("clamps an oversized maxResults to the hard cap", async () => {
		await client.searchDocuments({
			binding,
			scope: { type: "general" },
			query: "hello",
			maxResults: 500,
		});
		expect(searchLimit()).toBe(20);
	});

	it("clamps a non-positive maxResults up to one", async () => {
		await client.searchDocuments({
			binding,
			scope: { type: "general" },
			query: "hello",
			maxResults: 0,
		});
		expect(searchLimit()).toBe(1);
	});
});

describe("searchDocuments — audit ledger", () => {
	it("writes one audit row carrying binding, scope, query, and returned document ids", async () => {
		kb.respond((text) =>
			isSearch({ text, params: [] })
				? [
						{ passage_id: "p1", document_id: "d1", title: "A", snippet: "s" },
						{ passage_id: "p2", document_id: "d2", title: "B", snippet: "s" },
						{ passage_id: "p3", document_id: "d1", title: "A", snippet: "s" },
					]
				: [],
		);

		await client.searchDocuments({
			binding,
			scope: { type: "general" },
			query: "hello",
		});

		const audits = agent.calls.filter(isAuditInsert);
		expect(audits).toHaveLength(1);
		// Column order documented on recordDocumentAccess:
		// (run_id, conversation_id, user_id, scope_type, scope_id, query, document_ids)
		expect(audits[0]?.params).toEqual([
			"run-1",
			"conv-1",
			"member-1",
			"general",
			null,
			"hello",
			["d1", "d2"], // deduplicated, in first-hit order
		]);
	});

	it("a no-hit search still writes an audit row with an empty document id array", async () => {
		kb.respond(() => []);

		await client.searchDocuments({
			binding,
			scope: { type: "general" },
			query: "nothing matches",
		});

		const audits = agent.calls.filter(isAuditInsert);
		expect(audits).toHaveLength(1);
		expect(audits[0]?.params?.[6]).toEqual([]);
	});
});

describe("searchDocuments — bounded errors", () => {
	// A worst-case driver error: carries the SQL text and the connection string.
	const leakyError = new Error(
		'syntax error in "SELECT p.id AS passage_id" while connected to postgresql://reader:kb-secret@kb-host:5432/mymemo_kb',
	);

	it("reduces a KB failure to a fixed message leaking neither SQL nor credentials", async () => {
		const logged: Record<string, unknown>[] = [];
		client = createScopedDocumentQueryClient({
			kbDb: {
				async query() {
					throw leakyError;
				},
			},
			agentDb: agent.db,
			logger: { ...noopLogger, error: (obj) => logged.push(obj) },
		});

		const rejection = await rejectionOf(
			client.searchDocuments({
				binding,
				scope: { type: "general" },
				query: "hello",
			}),
		);
		expect(rejection).toBeInstanceOf(DocumentQueryError);
		expect(rejection.message).toBe("document search failed");
		expect(rejection.message).not.toContain("SELECT");
		expect(rejection.message).not.toContain("kb-secret");
		expect(rejection.message).not.toContain("postgresql://");
		// The real cause is preserved for operators in the worker log.
		expect(logged.length).toBeGreaterThan(0);
	});

	it("fails closed when the audit ledger write fails, with the same bounded message", async () => {
		client = createScopedDocumentQueryClient({
			kbDb: kb.db,
			agentDb: {
				async query() {
					throw leakyError;
				},
			},
			logger: noopLogger,
		});

		const rejection = await rejectionOf(
			client.searchDocuments({
				binding,
				scope: { type: "general" },
				query: "hello",
			}),
		);
		expect(rejection).toBeInstanceOf(DocumentQueryError);
		expect(rejection.message).toBe("document search failed");
		expect(rejection.message).not.toContain("kb-secret");
	});
});

const isFetch = (c: Call) => /FROM document\b/.test(c.text);
const OUT_OF_SCOPE = "document is not available in this conversation's scope";

function respondFetch(row: {
	document_id: string;
	title: string;
	content: string;
	content_length: number;
}) {
	kb.respond((text) => (isFetch({ text, params: [] }) ? [row] : []));
}

describe("fetchDocumentInScope — scope guard and audit", () => {
	it("general scope: fetches a workspace document and audits it as a fetch", async () => {
		respondFetch({
			document_id: "d1",
			title: "Doc one",
			content: "body",
			content_length: 4,
		});

		const doc = await client.fetchDocumentInScope({
			binding,
			scope: { type: "general" },
			documentId: "d1",
		});

		expect(doc).toEqual({
			documentId: "d1",
			title: "Doc one",
			content: "body",
			truncated: false,
		});
		const fetch = kb.calls.find(isFetch);
		expect(fetch?.params?.[0]).toBe("d1");
		expect(fetch?.params?.[1]).toBe("member-1"); // workspace pin
		const audits = agent.calls.filter(isAuditInsert);
		expect(audits).toHaveLength(1);
		expect(audits[0]?.params?.[5]).toBeNull(); // query is null for a fetch
		expect(audits[0]?.params?.[6]).toEqual(["d1"]);
	});

	it("document scope: rejects a document other than the frozen one before any fetch", async () => {
		kb.respond((text) =>
			text.includes("content_asset") ? [{ kb_document_id: "kb-doc-9" }] : [],
		);

		const rejection = await rejectionOf(
			client.fetchDocumentInScope({
				binding,
				scope: { type: "document", summaryId: "12345" },
				documentId: "other-doc",
			}),
		);

		expect(rejection).toBeInstanceOf(DocumentScopeError);
		expect(rejection.message).toBe(OUT_OF_SCOPE);
		expect(kb.calls.find(isFetch)).toBeUndefined();
		expect(agent.calls.filter(isAuditInsert)).toHaveLength(0);
	});

	it("document scope: allows fetching exactly the frozen document", async () => {
		kb.respond((text) => {
			if (text.includes("content_asset")) return [{ kb_document_id: "d9" }];
			if (isFetch({ text, params: [] }))
				return [
					{ document_id: "d9", title: "T", content: "c", content_length: 1 },
				];
			return [];
		});

		const doc = await client.fetchDocumentInScope({
			binding,
			scope: { type: "document", summaryId: "12345" },
			documentId: "d9",
		});
		expect(doc.documentId).toBe("d9");
	});

	it("collection scope: rejects a document outside the frozen collection", async () => {
		kb.respond(() => []); // membership probe finds nothing

		const rejection = await rejectionOf(
			client.fetchDocumentInScope({
				binding,
				scope: { type: "collection", collectionId: "coll-7" },
				documentId: "d1",
			}),
		);

		expect(rejection).toBeInstanceOf(DocumentScopeError);
		expect(rejection.message).toBe(OUT_OF_SCOPE);
		expect(kb.calls.find(isFetch)).toBeUndefined();
	});

	it("collection scope: allows a document that is in the frozen collection", async () => {
		kb.respond((text) => {
			if (text.includes("passage_collection")) return [{ "?column?": 1 }];
			if (isFetch({ text, params: [] }))
				return [
					{ document_id: "d1", title: "T", content: "c", content_length: 1 },
				];
			return [];
		});

		const doc = await client.fetchDocumentInScope({
			binding,
			scope: { type: "collection", collectionId: "coll-7" },
			documentId: "d1",
		});
		expect(doc.documentId).toBe("d1");
	});

	it("an unknown document id gets the same message as an out-of-scope one (no existence leak)", async () => {
		kb.respond(() => []); // document not found

		const rejection = await rejectionOf(
			client.fetchDocumentInScope({
				binding,
				scope: { type: "general" },
				documentId: "ghost",
			}),
		);

		expect(rejection).toBeInstanceOf(DocumentScopeError);
		expect(rejection.message).toBe(OUT_OF_SCOPE);
	});

	it("marks content truncated when the stored document exceeds the excerpt cap", async () => {
		respondFetch({
			document_id: "d1",
			title: "Big",
			content: "clipped…",
			content_length: 120_000,
		});

		const doc = await client.fetchDocumentInScope({
			binding,
			scope: { type: "general" },
			documentId: "d1",
		});
		expect(doc.truncated).toBe(true);
	});

	it("reduces a KB failure to a fixed fetch message", async () => {
		client = createScopedDocumentQueryClient({
			kbDb: {
				async query() {
					throw new Error("connect ECONNREFUSED postgresql://r:kb-secret@h/db");
				},
			},
			agentDb: agent.db,
			logger: noopLogger,
		});

		const rejection = await rejectionOf(
			client.fetchDocumentInScope({
				binding,
				scope: { type: "general" },
				documentId: "d1",
			}),
		);
		expect(rejection).toBeInstanceOf(DocumentQueryError);
		expect(rejection.message).toBe("document fetch failed");
		expect(rejection.message).not.toContain("kb-secret");
	});
});

describe("createDocumentSearch — startup credential guard", () => {
	it("refuses to start without a KB credential", () => {
		expect(() =>
			createDocumentSearch(
				{
					kbDatabaseUrl: "",
					agentDatabaseUrl: "postgresql://u:p@localhost:5432/mymemo_agent",
				},
				noopLogger,
			),
		).toThrow(/KB_DATABASE_URL/);
	});

	it("refuses to start without the agent DB credential backing the audit ledger", () => {
		expect(() =>
			createDocumentSearch(
				{
					kbDatabaseUrl: "postgresql://r:r@localhost:5432/mymemo_kb",
					agentDatabaseUrl: "",
				},
				noopLogger,
			),
		).toThrow(/AGENT_DATABASE_URL/);
	});
});
