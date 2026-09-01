import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conversations, documentAccessEvents } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { PostgresDocumentAccessLog } from "@mymemo/document-tools/access-log";
import type { KbDb } from "@mymemo/document-tools/client";
import { DOCS_CACHE_DIRNAME } from "@mymemo/document-tools/tools";
import {
	buildDocTools,
	type CurrentTurn,
	DOC_TOOLS_ALLOWED_TOOLS,
	DOC_TOOLS_SERVER_NAME,
	type DocToolsDeps,
} from "./doc-tools";

const USER_ID = "vm-user";
const CONVERSATION_ID = "vm-conversation";

let tdb: TestDb;
let workspaceDir: string;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(documentAccessEvents);
	await tdb.db.delete(conversations);
	workspaceDir = await mkdtemp(path.join(os.tmpdir(), "in-vm-docs-"));
});

async function seedConversation(
	row: Partial<typeof conversations.$inferInsert> = {},
) {
	await tdb.db.insert(conversations).values({
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		scope: "general",
		...row,
	});
}

interface KbCall {
	text: string;
	params: unknown[];
}

/** Records every KB query; `respond` answers by SQL shape. */
function fakeKb(respond: (text: string) => unknown[] = () => []) {
	const calls: KbCall[] = [];
	const db: KbDb = {
		async query<T>(text: string, params: unknown[] = []) {
			calls.push({ text, params });
			return respond(text) as T[];
		},
	};
	return { db, calls };
}

function makeDeps(overrides: Partial<DocToolsDeps> = {}): {
	deps: DocToolsDeps;
	currentTurn: CurrentTurn;
	kbCalls: KbCall[];
} {
	const kb = fakeKb();
	const currentTurn: CurrentTurn = { turnId: "turn-1" };
	return {
		deps: {
			db: tdb.db,
			kb: kb.db,
			audit: new PostgresDocumentAccessLog(tdb.db),
			logger: { info() {}, error() {} },
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			workspaceDir,
			currentTurn,
			...overrides,
		},
		currentTurn,
		kbCalls: kb.calls,
	};
}

interface ToolResult {
	content: { type: string; text: string }[];
	isError?: boolean;
}

async function call(
	deps: DocToolsDeps,
	name: string,
	input: unknown,
): Promise<ToolResult> {
	const built = buildDocTools(deps).find((tool) => tool.name === name);
	if (!built) throw new Error(`tool ${name} not built`);
	return (await built.handler(input as never, {})) as ToolResult;
}

async function auditRows() {
	return await tdb.db
		.select({
			runId: documentAccessEvents.runId,
			operation: documentAccessEvents.operation,
			scopeType: documentAccessEvents.scopeType,
		})
		.from(documentAccessEvents)
		.orderBy(documentAccessEvents.id);
}

describe("the allowlist pin", () => {
	it("DOC_TOOLS_ALLOWED_TOOLS names exactly the tools actually built", () => {
		const { deps } = makeDeps();
		expect(DOC_TOOLS_ALLOWED_TOOLS).toEqual(
			buildDocTools(deps).map(
				(tool) => `mcp__${DOC_TOOLS_SERVER_NAME}__${tool.name}`,
			),
		);
	});
});

describe("Turn attribution", () => {
	it("audits every call under the in-flight Turn id", async () => {
		await seedConversation();
		const { deps } = makeDeps();
		const result = await call(deps, "ListDocuments", {});
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
			total: 0,
			documents: [],
			nextCursor: null,
		});
		expect(await auditRows()).toEqual([
			{ runId: "turn-1", operation: "list", scopeType: "general" },
		]);
	});

	it("fails closed when no Turn is being served — no KB read, no audit row", async () => {
		await seedConversation();
		const { deps, currentTurn, kbCalls } = makeDeps();
		currentTurn.turnId = null;
		const result = await call(deps, "SearchDocuments", { query: "hello" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(
			"SearchDocuments failed: no Turn is being served",
		);
		expect(kbCalls).toEqual([]);
		expect(await auditRows()).toEqual([]);
	});
});

describe("frozen Scope resolution", () => {
	it("fails closed while the conversation row is missing, then recovers", async () => {
		const { deps, kbCalls } = makeDeps();
		const failed = await call(deps, "ListDocuments", {});
		expect(failed.isError).toBe(true);
		expect(failed.content[0]?.text).toBe(
			"ListDocuments failed: the conversation scope could not be resolved",
		);
		expect(kbCalls).toEqual([]);

		// Only a successful read is cached: the same tool set works once the
		// Conversation row exists.
		await seedConversation();
		const recovered = await call(deps, "ListDocuments", {});
		expect(recovered.isError).toBeUndefined();
	});

	it("narrows a collection Conversation's queries to its frozen collection", async () => {
		await seedConversation({ scope: "collection", collectionId: "coll-7" });
		const { deps, kbCalls } = makeDeps();
		await call(deps, "SearchDocuments", { query: "hello" });
		const search = kbCalls.find((c) => c.text.includes("ts_rank_cd"));
		expect(search?.params).toContain("coll-7");
		expect(await auditRows()).toEqual([
			{ runId: "turn-1", operation: "search", scopeType: "collection" },
		]);
	});

	it("pins a document Conversation's queries to its resolved summary document", async () => {
		await seedConversation({ scope: "document", summaryId: "1001" });
		const kb = fakeKb((text) =>
			text.includes("content_asset") ? [{ kb_document_id: "kb-9" }] : [],
		);
		const { deps } = makeDeps({ kb: kb.db });
		await call(deps, "SearchDocuments", { query: "hello" });
		const search = kb.calls.find((c) => c.text.includes("ts_rank_cd"));
		expect(search?.text).toContain("document_id IN");
		expect(search?.params).toContain("kb-9");
		expect(await auditRows()).toEqual([
			{ runId: "turn-1", operation: "search", scopeType: "document" },
		]);
	});
});

describe("LoadDocuments — the Workspace docs cache", () => {
	function kbWithDocument(content: () => string) {
		return fakeKb((text) =>
			text.includes("canonical_markdown")
				? [
						{
							document_id: "d1",
							title: "Title",
							content: content(),
							content_length: content().length,
						},
					]
				: [],
		);
	}

	it("materializes metadata-only into the docs cache; re-Load refreshes", async () => {
		await seedConversation();
		let version = "first cached body";
		const kb = kbWithDocument(() => version);
		const { deps } = makeDeps({ kb: kb.db });

		const first = await call(deps, "LoadDocuments", { documentIds: ["d1"] });
		expect(first.isError).toBeUndefined();
		const cachePath = path.join(workspaceDir, DOCS_CACHE_DIRNAME, "d1.md");
		expect(await readFile(cachePath, "utf8")).toBe("first cached body");
		// Metadata only: the result names the path and byte count, never the body.
		const parsed = JSON.parse(first.content[0]?.text ?? "") as {
			loaded: unknown[];
			errors: unknown[];
		};
		expect(parsed.loaded).toEqual([
			{
				documentId: "d1",
				title: "Title",
				path: cachePath,
				bytes: Buffer.byteLength("first cached body"),
				truncated: false,
			},
		]);
		expect(first.content[0]?.text).not.toContain("first cached body");

		version = "refreshed body";
		const second = await call(deps, "LoadDocuments", { documentIds: ["d1"] });
		expect(second.isError).toBeUndefined();
		expect(await readFile(cachePath, "utf8")).toBe("refreshed body");
		expect((await auditRows()).map((row) => row.operation)).toEqual([
			"load",
			"load",
		]);
	});

	it("rejects an out-of-scope document: uniform error, no file, no audit row", async () => {
		await seedConversation({ scope: "collection", collectionId: "coll-7" });
		// The membership probe returns no row, so the fetch is refused before
		// any document row is read.
		const kb = kbWithDocument(() => "never cached");
		const { deps } = makeDeps({ kb: kb.db });
		const result = await call(deps, "LoadDocuments", { documentIds: ["d1"] });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
			loaded: [],
			errors: [
				{
					documentId: "d1",
					error: "document is not available in this conversation's scope",
				},
			],
		});
		await expect(
			stat(path.join(workspaceDir, DOCS_CACHE_DIRNAME, "d1.md")),
		).rejects.toThrow();
		expect(await auditRows()).toEqual([]);
	});
});
