import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { WorkerLogger } from "../logger";
import { createScopedDocumentQueryClient } from "./client";
import type { Db } from "./db";
import { runListDocumentsTool } from "./list-documents-tool";

const binding = {
	userId: "demo-member",
	conversationId: "conv-1",
	runId: "run-1",
};

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

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
	await pglite.exec(
		await readFile(join(import.meta.dir, "../../db/init.sql"), "utf8"),
	);
	await pglite.exec(`
		CREATE TABLE document_access_events (
			id bigserial PRIMARY KEY,
			run_id text NOT NULL,
			conversation_id text NOT NULL,
			user_id text NOT NULL,
			operation text NOT NULL,
			scope_type text NOT NULL,
			scope_id text,
			query text,
			document_ids text[] NOT NULL,
			result_count integer
		);
		INSERT INTO document (
			id, source_asset_id, workspace_id, version, title, source_type,
			language, canonical_markdown, status, created_at
		) VALUES (
			'doc-ml-intro-v2', 'asset-ml-intro', 'demo-member', 2,
			'Current ML introduction', 'markdown', 'en', 'current body',
			'active', '2026-01-03T00:00:00Z'
		);
	`);
});

afterAll(async () => {
	await pglite.close();
	(pglite as unknown as { mod?: unknown }).mod = undefined;
	Bun.gc(true);
});

function parseToolResult(result: { content: { text: string }[] }): {
	total: number;
	documents: Array<Record<string, unknown>>;
	nextCursor: string | null;
} {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

describe("ListDocuments tool — scoped client integration", () => {
	it("returns and audits exact current-version inventory across cursor pages", async () => {
		const client = createScopedDocumentQueryClient({
			kbDb: db,
			agentDb: db,
			logger: silentLogger,
		});
		const context = {
			client,
			binding,
			scope: { type: "general" as const },
			maxResults: 20,
		};

		const first = parseToolResult(
			await runListDocumentsTool({ limit: 1 }, context),
		);
		expect(first).toEqual({
			total: 2,
			documents: [
				{
					documentId: "doc-ml-intro-v2",
					title: "Current ML introduction",
					sourceType: "markdown",
					language: "en",
					createdAt: "2026-01-02T00:00:00.000Z",
				},
			],
			nextCursor: expect.any(String),
		});

		const second = parseToolResult(
			await runListDocumentsTool(
				{ limit: 1, cursor: first.nextCursor ?? undefined },
				context,
			),
		);
		expect(second).toEqual({
			total: 2,
			documents: [
				{
					documentId: "doc-mymemo-overview",
					title: "MyMemo Overview",
					sourceType: "markdown",
					language: "en",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			nextCursor: null,
		});

		const audits = await db.query<{
			operation: string;
			scope_type: string;
			scope_id: string | null;
			document_ids: string[];
			result_count: number;
		}>(
			`SELECT operation, scope_type, scope_id, document_ids, result_count
			   FROM document_access_events
			  ORDER BY id`,
		);
		expect(audits).toEqual([
			{
				operation: "list",
				scope_type: "general",
				scope_id: null,
				document_ids: ["doc-ml-intro-v2"],
				result_count: 2,
			},
			{
				operation: "list",
				scope_type: "general",
				scope_id: null,
				document_ids: ["doc-mymemo-overview"],
				result_count: 2,
			},
		]);
	});
});
