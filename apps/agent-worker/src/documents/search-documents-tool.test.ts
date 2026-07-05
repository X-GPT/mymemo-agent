import { describe, expect, it } from "bun:test";
import type { ScopedDocumentQueryClient } from "./client";
import { runSearchDocumentsTool } from "./search-documents-tool";

const binding = {
	userId: "member-1",
	conversationId: "conv-1",
	runId: "run-1",
};

function makeClient(
	searchDocuments: ScopedDocumentQueryClient["searchDocuments"],
): ScopedDocumentQueryClient {
	return {
		searchDocuments,
		async fetchDocumentInScope() {
			throw new Error("not used");
		},
	};
}

function parseResult(result: { content: { text: string }[] }) {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

describe("SearchDocuments tool", () => {
	it("returns citable passages with passageId and documentId", async () => {
		const result = await runSearchDocumentsTool(
			{ query: "revenue" },
			{
				client: makeClient(async () => ({
					passages: [
						{
							passageId: "p1",
							documentId: "d1",
							title: "Forecast",
							snippet: "Revenue increased.",
						},
					],
				})),
				binding,
				scope: { type: "general" },
				maxResults: 5,
			},
		);

		expect(result.isError).toBeUndefined();
		expect(parseResult(result)).toEqual({
			passages: [
				{
					passageId: "p1",
					documentId: "d1",
					title: "Forecast",
					snippet: "Revenue increased.",
				},
			],
		});
	});

	it("caps requested maxResults by worker config before calling the client", async () => {
		let observedMaxResults: number | undefined;
		await runSearchDocumentsTool(
			{ query: "revenue", maxResults: 50 },
			{
				client: makeClient(async (input) => {
					observedMaxResults = input.maxResults;
					return { passages: [] };
				}),
				binding,
				scope: { type: "collection", collectionId: "coll-1" },
				maxResults: 7,
			},
		);

		expect(observedMaxResults).toBe(7);
	});

	it("passes binding and frozen scope through to the scoped query client", async () => {
		const calls: unknown[] = [];
		await runSearchDocumentsTool(
			{ query: "  margin  ", maxResults: 3 },
			{
				client: makeClient(async (input) => {
					calls.push(input);
					return { passages: [] };
				}),
				binding,
				scope: { type: "document", summaryId: "12345" },
				maxResults: 7,
			},
		);

		expect(calls).toEqual([
			{
				binding,
				scope: { type: "document", summaryId: "12345" },
				query: "margin",
				maxResults: 3,
			},
		]);
	});

	it("returns a stable model-readable empty result", async () => {
		const result = await runSearchDocumentsTool(
			{ query: "nothing" },
			{
				client: makeClient(async () => ({ passages: [] })),
				binding,
				scope: { type: "general" },
				maxResults: 5,
			},
		);

		expect(result.isError).toBeUndefined();
		expect(parseResult(result)).toEqual({
			passages: [],
			message: "No MyMemo document passages matched the query.",
		});
	});

	it("maps bounded client errors to recoverable tool errors", async () => {
		const result = await runSearchDocumentsTool(
			{ query: "revenue" },
			{
				client: makeClient(async () => {
					throw new Error("document search failed");
				}),
				binding,
				scope: { type: "general" },
				maxResults: 5,
			},
		);

		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: "SearchDocuments failed: document search failed",
				},
			],
			isError: true,
		});
	});
});
