import { describe, expect, it } from "bun:test";
import type { ScopedDocumentQueryClient } from "./client";
import { DocumentScopeError } from "./errors";
import type { FetchedDocument } from "./kb-queries";
import {
	DOCS_CACHE_DIRNAME,
	LOAD_TRUNCATION_NOTICE,
	type LoadDocumentsCacheWriter,
	runLoadDocumentsTool,
} from "./load-documents-tool";

const binding = {
	userId: "member-1",
	conversationId: "conv-1",
	runId: "run-1",
};

const limits = {
	maxDocuments: 5,
	perDocumentMaxBytes: 1_000,
	perCallMaxBytes: 4_000,
};

/** Records the sandbox calls the tool makes. */
class FakeCacheWriter implements LoadDocumentsCacheWriter {
	readonly writes: { path: string; content: string }[] = [];
	readonly calls: string[] = [];
	writeError: Error | undefined;

	async writeFile(input: { path: string; content: string }): Promise<void> {
		this.calls.push("writeFile");
		this.writes.push(input);
		if (this.writeError) throw this.writeError;
	}
}

type FetchArgs = { documentId: string };

function makeClient(
	fetchDocumentInScope: (args: FetchArgs) => Promise<FetchedDocument>,
): ScopedDocumentQueryClient & { fetchCalls: FetchArgs[] } {
	const fetchCalls: FetchArgs[] = [];
	return {
		fetchCalls,
		async searchDocuments() {
			throw new Error("not used");
		},
		async fetchDocumentInScope(input) {
			fetchCalls.push({ documentId: input.documentId });
			return fetchDocumentInScope({ documentId: input.documentId });
		},
	};
}

function doc(overrides: Partial<FetchedDocument> & { documentId: string }) {
	return {
		title: "Untitled",
		content: "",
		truncated: false,
		...overrides,
	};
}

function baseContext(
	client: ScopedDocumentQueryClient,
	sandbox: FakeCacheWriter,
) {
	return {
		client,
		sandbox,
		binding,
		scope: { type: "general" } as const,
		workspaceRoot: "/workspace",
		limits,
	};
}

function parseResult(result: { content: { text: string }[] }) {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

describe("LoadDocuments tool", () => {
	it("returns metadata only and writes the body to the reserved docs cache", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, title: "Q4 Plan", content: "SECRET BODY" }),
		);
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["doc-1"] },
			baseContext(client, sandbox),
		);

		expect(result.isError).toBeUndefined();
		const parsed = parseResult(result);
		expect(parsed).toEqual({
			loaded: [
				{
					documentId: "doc-1",
					title: "Q4 Plan",
					path: `${DOCS_CACHE_DIRNAME}/doc-1.md`,
					truncated: false,
				},
			],
			errors: [],
		});
		// The document body must never appear in the tool result / run events.
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
		// It lands on disk under the reserved cache dir at a workspace-rooted path.
		expect(sandbox.writes).toEqual([
			{ path: "/workspace/.mymemo/docs/doc-1.md", content: "SECRET BODY" },
		]);
	});

	it("passes the binding and frozen scope to the scoped client so the load is audited", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "body" }),
		);
		const sandbox = new FakeCacheWriter();

		await runLoadDocumentsTool(
			{ documentIds: ["doc-1"] },
			{
				...baseContext(client, sandbox),
				scope: { type: "document", summaryId: "42" },
			},
		);

		// fetchDocumentInScope is the only path that writes document_access_events.
		expect(client.fetchCalls).toEqual([{ documentId: "doc-1" }]);
	});

	it("surfaces the uniform scope error without leaking existence and writes nothing", async () => {
		const client = makeClient(async () => {
			throw new DocumentScopeError(
				"document is not available in this conversation's scope",
			);
		});
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["ghost"] },
			baseContext(client, sandbox),
		);

		expect(result.isError).toBeUndefined();
		expect(parseResult(result)).toEqual({
			loaded: [],
			errors: [
				{
					documentId: "ghost",
					error: "document is not available in this conversation's scope",
				},
			],
		});
		expect(sandbox.writes).toEqual([]);
	});

	it("loads the healthy ids and reports errors for the rest", async () => {
		const client = makeClient(async ({ documentId }) => {
			if (documentId === "bad") {
				throw new DocumentScopeError(
					"document is not available in this conversation's scope",
				);
			}
			return doc({ documentId, title: "Good", content: "ok" });
		});
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["good", "bad"] },
			baseContext(client, sandbox),
		);

		const parsed = parseResult(result);
		expect(parsed.loaded).toEqual([
			{
				documentId: "good",
				title: "Good",
				path: `${DOCS_CACHE_DIRNAME}/good.md`,
				truncated: false,
			},
		]);
		expect(parsed.errors).toEqual([
			{
				documentId: "bad",
				error: "document is not available in this conversation's scope",
			},
		]);
		expect(sandbox.writes.map((w) => w.path)).toEqual([
			"/workspace/.mymemo/docs/good.md",
		]);
	});

	it("enforces the per-document byte cap, marking truncation in the file and the result", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "A".repeat(50) }),
		);
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["big"] },
			{
				...baseContext(client, sandbox),
				limits: { ...limits, perDocumentMaxBytes: 10 },
			},
		);

		const parsed = parseResult(result);
		expect(parsed.loaded[0].truncated).toBe(true);
		const written = sandbox.writes[0];
		if (!written) throw new Error("expected a cache write");
		expect(written.content.startsWith("A".repeat(10))).toBe(true);
		expect(written.content).toContain(LOAD_TRUNCATION_NOTICE);
		// Only the first 10 content bytes survive the cap (marker aside).
		expect(written.content.replace(LOAD_TRUNCATION_NOTICE, "")).toBe(
			"A".repeat(10),
		);
	});

	it("propagates truncation reported by the query client", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "clipped", truncated: true }),
		);
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["doc-1"] },
			baseContext(client, sandbox),
		);

		const parsed = parseResult(result);
		expect(parsed.loaded[0].truncated).toBe(true);
		expect(sandbox.writes[0]?.content).toContain(LOAD_TRUNCATION_NOTICE);
	});

	it("enforces the per-call byte budget across documents", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "B".repeat(30) }),
		);
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["one", "two", "three"] },
			{
				...baseContext(client, sandbox),
				limits: { ...limits, perDocumentMaxBytes: 30, perCallMaxBytes: 40 },
			},
		);

		const parsed = parseResult(result);
		// First doc takes 30 bytes, second is clipped to the remaining 10 (truncated),
		// third gets no budget and errors without being fetched.
		expect(
			parsed.loaded.map((l: { documentId: string }) => l.documentId),
		).toEqual(["one", "two"]);
		expect(parsed.loaded[1].truncated).toBe(true);
		expect(parsed.errors).toEqual([
			{
				documentId: "three",
				error: "per-call byte budget exhausted; load fewer documents.",
			},
		]);
		// The budget-exhausted id is never fetched (no audit, no KB read).
		expect(client.fetchCalls.map((c) => c.documentId)).toEqual(["one", "two"]);
	});

	it("refreshes an already-cached id by writing the same deterministic path", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "v" }),
		);
		const sandbox = new FakeCacheWriter();
		const ctx = baseContext(client, sandbox);

		await runLoadDocumentsTool({ documentIds: ["doc-1"] }, ctx);
		await runLoadDocumentsTool({ documentIds: ["doc-1"] }, ctx);

		expect(sandbox.writes.map((w) => w.path)).toEqual([
			"/workspace/.mymemo/docs/doc-1.md",
			"/workspace/.mymemo/docs/doc-1.md",
		]);
	});

	it("rejects a document id that is not a safe filename before fetching", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "x" }),
		);
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["../escape"] },
			baseContext(client, sandbox),
		);

		expect(parseResult(result)).toEqual({
			loaded: [],
			errors: [
				{
					documentId: "../escape",
					error: "document id is not a valid identifier.",
				},
			],
		});
		expect(client.fetchCalls).toEqual([]);
		expect(sandbox.writes).toEqual([]);
	});

	it("rejects an empty document id list", async () => {
		const client = makeClient(async ({ documentId }) => doc({ documentId }));
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: [] },
			baseContext(client, sandbox),
		);

		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: "LoadDocuments requires at least one document id.",
				},
			],
			isError: true,
		});
	});

	it("rejects a call that exceeds the max-documents cap", async () => {
		const client = makeClient(async ({ documentId }) => doc({ documentId }));
		const sandbox = new FakeCacheWriter();

		const result = await runLoadDocumentsTool(
			{ documentIds: ["a", "b", "c"] },
			{
				...baseContext(client, sandbox),
				limits: { ...limits, maxDocuments: 2 },
			},
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(
			"LoadDocuments accepts at most 2 document ids per call.",
		);
		expect(client.fetchCalls).toEqual([]);
	});

	it("deduplicates repeated ids within one call", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "body" }),
		);
		const sandbox = new FakeCacheWriter();

		await runLoadDocumentsTool(
			{ documentIds: ["doc-1", "doc-1"] },
			baseContext(client, sandbox),
		);

		expect(client.fetchCalls).toEqual([{ documentId: "doc-1" }]);
		expect(sandbox.writes).toHaveLength(1);
	});

	it("reports a bounded error when the cache write fails", async () => {
		const client = makeClient(async ({ documentId }) =>
			doc({ documentId, content: "body" }),
		);
		const sandbox = new FakeCacheWriter();
		sandbox.writeError = new Error("ENOSPC: no space left on device");

		const result = await runLoadDocumentsTool(
			{ documentIds: ["doc-1"] },
			baseContext(client, sandbox),
		);

		const parsed = parseResult(result);
		expect(parsed.loaded).toEqual([]);
		expect(parsed.errors[0].documentId).toBe("doc-1");
		expect(parsed.errors[0].error).toContain("failed to cache document");
	});
});
