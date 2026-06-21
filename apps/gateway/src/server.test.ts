import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type LlmTokenClaims, mintLlmToken } from "@mymemo/llm-token";
import type { Db } from "./db/client";
import type { GatewayConfig } from "./env";
import { createGateway } from "./server";

// Single source of truth: the app verifies with config.llmTokenSecret and the
// tests sign with the same value, so a sign/verify mismatch is unrepresentable.
const config: GatewayConfig = {
	anthropicApiKey: "test-anthropic-key",
	llmTokenSecret: "test-secret",
	databaseUrl: "postgres://test@localhost/test",
	upstreamBaseUrl: "https://api.anthropic.com",
	gatewayPort: 8080,
};
const SECRET = config.llmTokenSecret;

// Fake Db: records every query and replies via a per-test responder keyed off
// the SQL. Lets us assert the exact scope filters without a live Postgres.
interface Call {
	text: string;
	params: unknown[];
}
let calls: Call[] = [];
let responder: (text: string, params: unknown[]) => unknown[] = () => [];

const fakeDb: Db = {
	async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
		calls.push({ text, params });
		return responder(text, params) as T[];
	},
};

const app = createGateway(config, fakeDb);

// Defaults to the document audience since most callers below are the document
// reader suite; LLM-proxy callers pass `aud: "llm"` explicitly.
function token(extra: Partial<Omit<LlmTokenClaims, "exp">> = {}): string {
	return mintLlmToken(
		{
			aud: "documents",
			userId: "u1",
			sandboxId: "sbx",
			requestId: "req",
			...extra,
		},
		SECRET,
	);
}

function headers(t: string): Record<string, string> {
	return { authorization: `Bearer ${t}`, "content-type": "application/json" };
}

function kind(text: string): "search" | "resolveDoc" | "resolveColl" | "fetch" {
	if (text.includes("ts_rank_cd")) return "search";
	if (text.includes("FROM content_asset")) return "resolveDoc";
	if (text.includes("content_collection")) return "resolveColl";
	return "fetch";
}
const callOf = (k: ReturnType<typeof kind>) =>
	calls.find((c) => kind(c.text) === k);

// ── LLM proxy (verbatim from the former llm-gateway suite) ──
describe("gateway · llm proxy", () => {
	const validToken = () =>
		mintLlmToken(
			{ aud: "llm", userId: "u1", sandboxId: "sbx-1", requestId: "req-1" },
			SECRET,
		);

	let fetchSpy: ReturnType<typeof spyOn> | undefined;
	afterEach(() => fetchSpy?.mockRestore());

	it("answers GET and HEAD /health without a token", async () => {
		expect((await app.request("/health")).status).toBe(200);
		expect((await app.request("/health", { method: "HEAD" })).status).toBe(200);
	});

	it("rejects requests with no bearer token", async () => {
		const res = await app.request("/v1/messages", { method: "POST" });
		expect(res.status).toBe(401);
	});

	it("rejects an invalid bearer token", async () => {
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: { authorization: "Bearer not-a-real-token" },
		});
		expect(res.status).toBe(401);
	});

	it("rejects a token minted for the documents audience (no upstream call)", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("should not forward"),
		);
		const docToken = mintLlmToken(
			{
				aud: "documents",
				userId: "u1",
				sandboxId: "sbx-1",
				requestId: "req-1",
			},
			SECRET,
		);
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${docToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
		});
		expect(res.status).toBe(401);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("injects x-api-key and forwards anthropic headers for a valid token", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${validToken()}`,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
		});

		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		const sent = new Headers(init.headers);
		expect(sent.get("x-api-key")).toBe("test-anthropic-key");
		expect(sent.get("anthropic-version")).toBe("2023-06-01");
		expect(sent.has("authorization")).toBe(false);
	});

	it("404s a non-messages path even with a valid token (no upstream call)", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("should not forward"),
		);
		const res = await app.request("/v1/files", {
			method: "POST",
			headers: { authorization: `Bearer ${validToken()}` },
			body: "{}",
		});
		expect(res.status).toBe(404);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("normalizes a trailing slash and still proxies /v1/messages", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200 }),
		);
		const res = await app.request("/v1/messages/", {
			method: "POST",
			headers: {
				authorization: `Bearer ${validToken()}`,
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(res.status).toBe(200);
		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
	});

	it("normalizes a double-slash path and still proxies /v1/messages", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200 }),
		);
		const res = await app.request("//v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${validToken()}`,
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(res.status).toBe(200);
		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
	});
});

// ── Document reader (verbatim from the former document-gateway suite) ──
describe("gateway · document reader (FTS / Postgres)", () => {
	afterEach(() => {
		calls = [];
		responder = () => [];
	});

	it("rejects requests without a valid token (no DB touched)", async () => {
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("rejects a token minted for the llm audience (no DB touched)", async () => {
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ aud: "llm", scope: "global" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("rejects search when the token has no scope (fail closed)", async () => {
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token()),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it("global search pins workspace_id to the token userId and no doc filter", async () => {
		responder = (t) =>
			kind(t) === "search"
				? [{ passage_id: "p1", document_id: "d1", title: "T", snippet: "S" }]
				: [];
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "global" })),
			body: JSON.stringify({ query: "hello world" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			documents: [
				{ passageId: "p1", documentId: "d1", title: "T", snippet: "S" },
			],
		});
		const search = callOf("search");
		// global scope: no document filter — params are [workspace, query, limit].
		expect(search?.params).toEqual(["u1", "hello world", 8]);
		expect(search?.text).not.toContain("p.document_id IN");
	});

	it("document search resolves summaryId and restricts to that document", async () => {
		responder = (t) => {
			if (kind(t) === "resolveDoc") return [{ kb_document_id: "kb-doc-9" }];
			if (kind(t) === "search")
				return [
					{ passage_id: "p", document_id: "kb-doc-9", title: "", snippet: "" },
				];
			return [];
		};
		await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "document", summaryId: "42" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(callOf("resolveDoc")?.params).toEqual(["42", "u1"]);
		expect(callOf("search")?.text).toContain("p.document_id IN");
		expect(callOf("search")?.params).toContain("kb-doc-9");
	});

	it("document search with an unknown summaryId returns empty, no search", async () => {
		responder = () => []; // resolveDoc finds nothing
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "document", summaryId: "999" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(await res.json()).toEqual({ documents: [] });
		expect(callOf("search")).toBeUndefined();
	});

	it("document search with a non-numeric summaryId fails closed (no DB)", async () => {
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "document", summaryId: "not-a-number" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(await res.json()).toEqual({ documents: [] });
		// The numeric guard returns before the $1::bigint query runs.
		expect(callOf("resolveDoc")).toBeUndefined();
		expect(callOf("search")).toBeUndefined();
	});

	it("fetch clips document content to 50k chars", async () => {
		responder = (t) =>
			kind(t) === "fetch"
				? [{ document_id: "d1", title: "T", content: "body" }]
				: [];
		await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "global" })),
			body: JSON.stringify({ documentId: "d1" }),
		});
		expect(callOf("fetch")?.text).toContain("left(canonical_markdown, 50000)");
	});

	it("collection search joins the collection in one query (no pre-resolve)", async () => {
		responder = (t) =>
			kind(t) === "search"
				? [{ passage_id: "p", document_id: "d1", title: "", snippet: "" }]
				: [];
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "collection", collectionId: "col-1" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(200);
		// No separate roster query; the search joins passage_collection directly.
		expect(callOf("search")?.text).toContain("passage_collection");
		expect(callOf("search")?.params).toContain("col-1");
	});

	it("collection search returns empty when nothing matches (search still runs)", async () => {
		responder = () => []; // join yields no rows
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "collection", collectionId: "col-x" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(await res.json()).toEqual({ documents: [] });
		expect(callOf("search")).toBeDefined();
	});

	it("global fetch returns the document pinned to the workspace", async () => {
		responder = (t) =>
			kind(t) === "fetch"
				? [{ document_id: "d1", title: "T", content: "body" }]
				: [];
		const res = await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "global" })),
			body: JSON.stringify({ documentId: "d1" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			documentId: "d1",
			title: "T",
			content: "body",
		});
		expect(callOf("fetch")?.params).toEqual(["d1", "u1"]);
	});

	it("document-scope fetch rejects an out-of-scope documentId (no fetch)", async () => {
		responder = (t) =>
			kind(t) === "resolveDoc" ? [{ kb_document_id: "kb-doc-9" }] : [];
		const res = await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "document", summaryId: "42" })),
			body: JSON.stringify({ documentId: "kb-doc-other" }),
		});
		expect(res.status).toBe(403);
		expect(callOf("fetch")).toBeUndefined();
	});

	it("document-scope fetch allows the in-scope documentId", async () => {
		responder = (t) => {
			if (kind(t) === "resolveDoc") return [{ kb_document_id: "kb-doc-9" }];
			if (kind(t) === "fetch")
				return [{ document_id: "kb-doc-9", title: "T", content: "c" }];
			return [];
		};
		const res = await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "document", summaryId: "42" })),
			body: JSON.stringify({ documentId: "kb-doc-9" }),
		});
		expect(res.status).toBe(200);
	});

	it("collection-scope fetch rejects a document not in the collection (no fetch)", async () => {
		responder = () => []; // documentInCollection: no membership row
		const res = await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "collection", collectionId: "col-1" })),
			body: JSON.stringify({ documentId: "d2" }),
		});
		expect(res.status).toBe(403);
		expect(callOf("fetch")).toBeUndefined();
	});

	it("collection-scope fetch allows a document in the collection", async () => {
		responder = (t) => {
			if (kind(t) === "resolveColl") return [{ one: 1 }]; // membership found
			if (kind(t) === "fetch")
				return [{ document_id: "d1", title: "T", content: "c" }];
			return [];
		};
		const res = await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "collection", collectionId: "col-1" })),
			body: JSON.stringify({ documentId: "d1" }),
		});
		expect(res.status).toBe(200);
	});

	it("returns 404 when the document is missing / not in the workspace", async () => {
		responder = () => []; // fetch finds nothing
		const res = await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "global" })),
			body: JSON.stringify({ documentId: "nope" }),
		});
		expect(res.status).toBe(404);
	});

	// --- fail-closed on empty identity/scope ids ---
	it("rejects collection scope with no collectionId (fail closed, no DB)", async () => {
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "collection" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it("rejects document scope with no summaryId (fail closed, no DB)", async () => {
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "document" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it("rejects a token with an empty userId (fail closed, no DB)", async () => {
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ userId: "", scope: "global" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	// --- DB errors map to 502 (not 500 / not 404) ---
	it("maps a search DB error to 502", async () => {
		responder = () => {
			throw new Error("db down");
		};
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "global" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(502);
	});

	it("maps a scope-resolution DB error to 502 (not unhandled 500)", async () => {
		responder = (t) => {
			if (kind(t) === "resolveDoc") throw new Error("db down");
			return [];
		};
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "document", summaryId: "42" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(502);
	});

	it("maps a fetch DB error to 502 (not 404)", async () => {
		responder = () => {
			throw new Error("db down");
		};
		const res = await app.request("/v1/documents/fetch", {
			method: "POST",
			headers: headers(token({ scope: "global" })),
			body: JSON.stringify({ documentId: "d1" }),
		});
		expect(res.status).toBe(502);
	});
});

// ── Routing isolation: the merge must not let the two families collide ──
// The document routes are registered before the LLM catch-all, so /v1/documents/*
// is handled by the document reader and never proxied to Anthropic; /v1/messages
// still proxies; other /v1/* still 404 on the proxy's path allowlist.
describe("gateway · routing isolation", () => {
	let fetchSpy: ReturnType<typeof spyOn> | undefined;
	afterEach(() => {
		fetchSpy?.mockRestore();
		calls = [];
		responder = () => [];
	});

	it("routes /v1/documents/search to the document handler, never the Anthropic proxy", async () => {
		// fetch would only be called by the LLM proxy; assert it never is.
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("document request must not reach the Anthropic proxy"),
		);
		responder = () => []; // global search → empty result set
		const res = await app.request("/v1/documents/search", {
			method: "POST",
			headers: headers(token({ scope: "global" })),
			body: JSON.stringify({ query: "x" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ documents: [] });
		expect(fetchSpy).not.toHaveBeenCalled();
		// It hit the DB seam — i.e. the document handler ran.
		expect(callOf("search")).toBeDefined();
	});

	it("still proxies /v1/messages to Anthropic with a valid token", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200 }),
		);
		const res = await app.request("/v1/messages", {
			method: "POST",
			headers: headers(token({ aud: "llm", scope: "global" })),
			body: "{}",
		});
		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
	});

	it("still 404s another /v1/* path (e.g. /v1/files) with a valid token", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("should not forward"),
		);
		const res = await app.request("/v1/files", {
			method: "POST",
			headers: headers(token({ aud: "llm", scope: "global" })),
			body: "{}",
		});
		expect(res.status).toBe(404);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("answers /health on GET and HEAD without a token", async () => {
		expect((await app.request("/health")).status).toBe(200);
		expect((await app.request("/health", { method: "HEAD" })).status).toBe(200);
	});
});
