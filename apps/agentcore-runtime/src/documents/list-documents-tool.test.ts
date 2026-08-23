import { describe, expect, it } from "bun:test";
import { runListDocumentsTool } from "./list-documents-tool";

const binding = {
	userId: "member-1",
	conversationId: "conv-1",
	runId: "run-1",
};

function parseResult(result: { content: { text: string }[] }) {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

describe("ListDocuments tool", () => {
	it("returns the exact scoped total and bounded document metadata", async () => {
		const calls: unknown[] = [];
		const result = await runListDocumentsTool(
			{ limit: 2 },
			{
				client: {
					async listDocuments(input: unknown) {
						calls.push(input);
						return {
							total: 42,
							documents: [
								{
									documentId: "doc-v3",
									title: "Quarterly Plan",
									sourceType: "pdf",
									language: "en",
									createdAt: "2026-07-01T12:00:00.000Z",
								},
							],
							next: null,
						};
					},
				},
				binding,
				scope: { type: "general" },
				maxResults: 20,
			},
		);

		expect(result.isError).toBeUndefined();
		expect(parseResult(result)).toEqual({
			total: 42,
			documents: [
				{
					documentId: "doc-v3",
					title: "Quarterly Plan",
					sourceType: "pdf",
					language: "en",
					createdAt: "2026-07-01T12:00:00.000Z",
				},
			],
			nextCursor: null,
		});
		expect(calls).toEqual([
			{
				binding,
				scope: { type: "general" },
				limit: 2,
				after: null,
			},
		]);
	});

	it("round-trips the opaque cursor without exposing its structure", async () => {
		const calls: unknown[] = [];
		const client = {
			async listDocuments(input: unknown) {
				calls.push(input);
				return calls.length === 1
					? {
							total: 2,
							documents: [],
							next: {
								createdAt: "2026-07-01T12:00:00.000Z",
								sourceAssetId: "asset-7",
							},
						}
					: { total: 2, documents: [], next: null };
			},
		};
		const context = {
			client,
			binding,
			scope: { type: "general" } as const,
			maxResults: 20,
		};

		const first = parseResult(await runListDocumentsTool({}, context));
		expect(typeof first.nextCursor).toBe("string");
		expect(first.nextCursor).not.toContain("asset-7");

		await runListDocumentsTool({ cursor: first.nextCursor }, context);
		expect(calls[1]).toEqual({
			binding,
			scope: { type: "general" },
			limit: 20,
			after: {
				createdAt: "2026-07-01T12:00:00.000Z",
				sourceAssetId: "asset-7",
			},
		});
	});

	it("rejects malformed, unsupported, and oversized cursors before client access", async () => {
		let called = false;
		const encode = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const context = {
			client: {
				async listDocuments() {
					called = true;
					return { total: 0, documents: [], next: null };
				},
			},
			binding,
			scope: { type: "general" } as const,
			maxResults: 20,
		};
		const validCursor = encode({
			version: 1,
			createdAt: "2026-07-01T12:00:00.000Z",
			sourceAssetId: "asset-7",
		});
		for (const cursor of [
			"",
			"not-a-cursor",
			`${validCursor}!`,
			`${validCursor}=`,
			encode({
				version: 2,
				createdAt: "2026-07-01T12:00:00.000Z",
				sourceAssetId: "asset-7",
			}),
			encode({ version: 1, createdAt: "not-a-date", sourceAssetId: "asset-7" }),
			encode({
				version: 1,
				createdAt: "2026-07-01T12:00:00.000Z",
				sourceAssetId: "",
			}),
			"x".repeat(4_097),
		]) {
			const result = await runListDocumentsTool({ cursor }, context);
			expect(result).toEqual({
				content: [
					{
						type: "text",
						text: "ListDocuments failed: invalid cursor",
					},
				],
				isError: true,
			});
		}
		expect(called).toBe(false);
	});

	it("caps a requested page by both Runtime config and the hard backstop", async () => {
		let observedLimit: number | undefined;
		await runListDocumentsTool(
			{ limit: 500 },
			{
				client: {
					async listDocuments(input) {
						observedLimit = input.limit;
						return { total: 0, documents: [], next: null };
					},
				},
				binding,
				scope: { type: "general" },
				maxResults: 200,
			},
		);

		expect(observedLimit).toBe(100);
	});

	it("maps bounded client failures to a recoverable tool error", async () => {
		const result = await runListDocumentsTool(
			{},
			{
				client: {
					async listDocuments() {
						throw new Error("document list failed");
					},
				},
				binding,
				scope: { type: "general" },
				maxResults: 20,
			},
		);

		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: "ListDocuments failed: document list failed",
				},
			],
			isError: true,
		});
	});
});
