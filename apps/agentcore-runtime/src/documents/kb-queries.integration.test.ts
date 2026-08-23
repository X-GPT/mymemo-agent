import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db";
import {
	fetchDocument,
	listDocuments,
	resolveDocumentId,
	searchPassages,
} from "./kb-queries";

let pglite: PGlite;
let db: Db;

beforeAll(async () => {
	pglite = new PGlite();
	await pglite.waitReady;
	db = {
		async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
			const result = await pglite.query<T>(text, params);
			return result.rows;
		},
	};
	await pglite.exec(`
		CREATE TABLE source_asset (
			id text PRIMARY KEY,
			workspace_id text NOT NULL,
			status text NOT NULL,
			created_at timestamptz NOT NULL
		);
		CREATE TABLE document (
			id text PRIMARY KEY,
			source_asset_id text NOT NULL,
			workspace_id text NOT NULL,
			version integer NOT NULL,
			title text NOT NULL,
			source_type text NOT NULL,
			language text NOT NULL,
			canonical_markdown text NOT NULL,
			status text NOT NULL
		);
		CREATE TABLE passage (
			id text PRIMARY KEY,
			document_id text NOT NULL,
			workspace_id text NOT NULL,
			passage_text text NOT NULL,
			search_tsv tsvector NOT NULL,
			status text NOT NULL
		);
		CREATE TABLE content_collection (
			compat_int_id bigint PRIMARY KEY,
			compat_str_id text NOT NULL
		);
		CREATE TABLE passage_collection (
			passage_id text NOT NULL,
			collection_id text NOT NULL
		);
		CREATE TABLE content_asset (
			compat_int_id bigint NOT NULL,
			member_code text NOT NULL,
			kb_document_id text NOT NULL
		);

		INSERT INTO source_asset VALUES
			('asset-new', 'member-1', 'ready', '2026-07-10T12:00:00Z'),
			('asset-old', 'member-1', 'ready', '2026-06-01T08:00:00Z'),
			('asset-other', 'member-2', 'ready', '2026-07-11T12:00:00Z');
		INSERT INTO document VALUES
			('doc-new-v1', 'asset-new', 'member-1', 1, 'Old title', 'pdf', 'en', 'old body', 'active'),
			('doc-new-v2', 'asset-new', 'member-1', 2, 'Current title', 'pdf', 'en', 'current body', 'active'),
			('doc-old-v1', 'asset-old', 'member-1', 1, 'Older document', 'note', 'zh', 'older body', 'active'),
			('doc-other', 'asset-other', 'member-2', 1, 'Other member', 'pdf', 'en', 'secret', 'active');
		INSERT INTO passage VALUES
			('passage-old-version', 'doc-new-v1', 'member-1', 'roadmap obsolete', to_tsvector('simple', 'roadmap obsolete'), 'active'),
			('passage-current', 'doc-new-v2', 'member-1', 'roadmap current', to_tsvector('simple', 'roadmap current'), 'active'),
			('passage-older-document', 'doc-old-v1', 'member-1', 'roadmap archive', to_tsvector('simple', 'roadmap archive'), 'active'),
			('passage-other', 'doc-other', 'member-2', 'roadmap secret', to_tsvector('simple', 'roadmap secret'), 'active');
		INSERT INTO content_collection VALUES (7, 'collection-7');
		INSERT INTO passage_collection VALUES
			('passage-current', '7'),
			('passage-old-version', '7');
		INSERT INTO content_asset VALUES (12345, 'member-1', 'doc-new-v1');
	`);
});

afterAll(async () => {
	await pglite.close();
});

describe("KB query contract — current searchable documents", () => {
	it("lists logical documents with an exact total and stable cursor pages", async () => {
		const first = await listDocuments(db, {
			workspaceId: "member-1",
			documentIds: null,
			collectionId: null,
			limit: 1,
			after: null,
		});

		expect(first).toEqual({
			total: 2,
			documents: [
				{
					documentId: "doc-new-v2",
					title: "Current title",
					sourceType: "pdf",
					language: "en",
					createdAt: "2026-07-10T12:00:00.000Z",
				},
			],
			next: {
				createdAt: "2026-07-10T12:00:00.000Z",
				sourceAssetId: "asset-new",
			},
		});

		const second = await listDocuments(db, {
			workspaceId: "member-1",
			documentIds: null,
			collectionId: null,
			limit: 1,
			after: first.next,
		});
		expect(second.total).toBe(2);
		expect(second.documents.map((document) => document.documentId)).toEqual([
			"doc-old-v1",
		]);
		expect(second.next).toBeNull();
	});

	it("derives collection and document inventory scope from current versions", async () => {
		const collection = await listDocuments(db, {
			workspaceId: "member-1",
			documentIds: null,
			collectionId: "collection-7",
			limit: 20,
			after: null,
		});
		expect(collection.total).toBe(1);
		expect(collection.documents[0]?.documentId).toBe("doc-new-v2");

		const document = await listDocuments(db, {
			workspaceId: "member-1",
			documentIds: ["doc-new-v2"],
			collectionId: null,
			limit: 20,
			after: null,
		});
		expect(document.total).toBe(1);
		expect(document.documents[0]?.documentId).toBe("doc-new-v2");
	});

	it("searches, resolves, and loads only the highest active version", async () => {
		const hits = await searchPassages(db, {
			workspaceId: "member-1",
			query: "roadmap",
			documentIds: null,
			collectionId: null,
			limit: 20,
		});
		expect(hits.map((hit) => hit.documentId).sort()).toEqual(
			["doc-new-v2", "doc-old-v1"].sort(),
		);

		expect(
			await resolveDocumentId(db, {
				summaryId: "12345",
				memberCode: "member-1",
			}),
		).toBe("doc-new-v2");
		expect(
			await fetchDocument(db, {
				workspaceId: "member-1",
				documentId: "doc-new-v1",
				maxChars: 100,
			}),
		).toBeNull();
		expect(
			await fetchDocument(db, {
				workspaceId: "member-1",
				documentId: "doc-new-v2",
				maxChars: 100,
			}),
		).toEqual({
			documentId: "doc-new-v2",
			title: "Current title",
			content: "current body",
			truncated: false,
		});
	});
});
