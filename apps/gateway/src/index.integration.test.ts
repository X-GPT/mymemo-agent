import { beforeAll, describe, expect, it } from "bun:test";
import { mintLlmToken } from "@mymemo/llm-token";

/**
 * Integration test: exercises the REAL Bun.sql wiring + SQL against a throwaway
 * Postgres (the unit tests use a fake Db). Gated on DOC_GATEWAY_IT so the normal
 * suite skips it. Run:
 *   docker run -d --name pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=kbtest \
 *     -p 55432:5432 postgres:16
 *   DOC_GATEWAY_IT=1 DB_SSL=disable \
 *   DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/kbtest \
 *   bun test apps/gateway/src/index.integration.test.ts
 */

const RUN = !!Bun.env.DOC_GATEWAY_IT;
const SECRET = "test-secret";

const WS = "member-ws-1"; // workspace_id = member_code (= token userId)
const DOC = "doc-uuid-1";
const PASSAGE = "passage-uuid-1";
const SUMMARY_ID = "12345"; // platform_knowledge.id = content_asset.compat_int_id
const COLLECTION = "col-compat-str"; // content_collection.compat_str_id
const COLLECTION_INT = "98765"; // content_collection.compat_int_id
const LONG = "Full content about machine learning. ".repeat(2000); // >50k chars

let app: typeof import("./index").app;

function tok(extra: Record<string, unknown> = {}): string {
	return mintLlmToken(
		{ userId: WS, sandboxId: "s", requestId: "r", ...extra },
		SECRET,
	);
}
function hdr(t: string): Record<string, string> {
	return { authorization: `Bearer ${t}`, "content-type": "application/json" };
}
function post(path: string, t: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		headers: hdr(t),
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	if (!RUN) return;
	Bun.env.LLM_TOKEN_SECRET = SECRET;
	Bun.env.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY ?? "test-anthropic-key";
	({ app } = await import("./index"));
	const { getDb } = await import("./db");
	const db = getDb();

	await db.query(
		"drop table if exists passage_collection, passage, document, content_asset, content_collection, workspace cascade",
	);
	await db.query("create table workspace (id text primary key)");
	await db.query(
		"create table document (id text primary key, workspace_id text, title text, canonical_markdown text, status text)",
	);
	await db.query(
		"create table passage (id text primary key, document_id text, workspace_id text, passage_text text, search_tsv tsvector, status text)",
	);
	await db.query(
		"create table content_asset (compat_int_id bigint, member_code text, kb_document_id text)",
	);
	await db.query(
		"create table content_collection (compat_int_id bigint, compat_str_id text, member_code text)",
	);
	await db.query(
		"create table passage_collection (passage_id text, collection_id text)",
	);

	await db.query("insert into workspace (id) values ($1)", [WS]);
	await db.query(
		"insert into document (id, workspace_id, title, canonical_markdown, status) values ($1,$2,$3,$4,'active')",
		[DOC, WS, "ML Intro", LONG],
	);
	await db.query(
		"insert into passage (id, document_id, workspace_id, passage_text, search_tsv, status) values ($1,$2,$3,$4, to_tsvector('simple',$4), 'active')",
		[
			PASSAGE,
			DOC,
			WS,
			"machine learning is a subset of artificial intelligence",
		],
	);
	await db.query(
		"insert into content_asset (compat_int_id, member_code, kb_document_id) values ($1,$2,$3)",
		[SUMMARY_ID, WS, DOC],
	);
	await db.query(
		"insert into content_collection (compat_int_id, compat_str_id, member_code) values ($1,$2,$3)",
		[COLLECTION_INT, COLLECTION, WS],
	);
	// passage_collection.collection_id mirrors content_collection.compat_int_id::text
	await db.query(
		"insert into passage_collection (passage_id, collection_id) values ($1,$2)",
		[PASSAGE, COLLECTION_INT],
	);
});

describe.skipIf(!RUN)(
	"gateway document reader integration (real Postgres)",
	() => {
		it("global search returns the FTS hit", async () => {
			const res = await post("/v1/documents/search", tok({ scope: "global" }), {
				query: "machine",
			});
			expect(res.status).toBe(200);
			const { documents } = (await res.json()) as {
				documents: { passageId: string; documentId: string; title: string }[];
			};
			expect(documents).toHaveLength(1);
			expect(documents[0]).toMatchObject({
				passageId: PASSAGE,
				documentId: DOC,
				title: "ML Intro",
			});
		});

		it("global search misses on a non-matching term", async () => {
			const res = await post("/v1/documents/search", tok({ scope: "global" }), {
				query: "quantumzzz",
			});
			expect(
				((await res.json()) as { documents: unknown[] }).documents,
			).toHaveLength(0);
		});

		it("fetch returns content clipped to 50k", async () => {
			const res = await post("/v1/documents/fetch", tok({ scope: "global" }), {
				documentId: DOC,
			});
			expect(res.status).toBe(200);
			const doc = (await res.json()) as { content: string; title: string };
			expect(doc.title).toBe("ML Intro");
			expect(doc.content.length).toBe(50000);
		});

		it("document scope resolves summaryId and restricts to it (exercises ::bigint + ANY)", async () => {
			const t = tok({ scope: "document", summaryId: SUMMARY_ID });
			const res = await post("/v1/documents/search", t, { query: "machine" });
			expect(
				((await res.json()) as { documents: unknown[] }).documents,
			).toHaveLength(1);
			// fetch in scope ok; out of scope forbidden
			expect(
				(await post("/v1/documents/fetch", t, { documentId: DOC })).status,
			).toBe(200);
			expect(
				(await post("/v1/documents/fetch", t, { documentId: "other" })).status,
			).toBe(403);
		});

		it("collection scope restricts to the collection's documents", async () => {
			const t = tok({ scope: "collection", collectionId: COLLECTION });
			const res = await post("/v1/documents/search", t, { query: "machine" });
			expect(
				((await res.json()) as { documents: unknown[] }).documents,
			).toHaveLength(1);
			expect(
				(await post("/v1/documents/fetch", t, { documentId: DOC })).status,
			).toBe(200);
		});

		it("a different workspace sees nothing (the workspace pin)", async () => {
			const t = mintLlmToken(
				{
					userId: "other-member",
					sandboxId: "s",
					requestId: "r",
					scope: "global",
				},
				SECRET,
			);
			const res = await post("/v1/documents/search", t, { query: "machine" });
			expect(
				((await res.json()) as { documents: unknown[] }).documents,
			).toHaveLength(0);
			expect(
				(await post("/v1/documents/fetch", t, { documentId: DOC })).status,
			).toBe(404);
		});
	},
);
