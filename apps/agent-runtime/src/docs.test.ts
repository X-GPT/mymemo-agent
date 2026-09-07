import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
	createScopedDocumentClient,
	type KbDb,
} from "@mymemo/document-tools/client";
import { createDocs } from "./docs";
import { createHand } from "./hand";

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("claude-agent-sdk"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = sdkRequire(
	"@modelcontextprotocol/sdk/inMemory.js",
);

test("docs MCP keeps invoke Scope and loads metadata through the Turn Hand", async () => {
	const writes: unknown[] = [];
	let fatal = false;
	let dead = false;
	const hand = createHand(
		async (name, args) => {
			if (dead) throw new Error("session is not active");
			if (name === "writeFiles") writes.push(args.content);
			return {
				content: [],
				structuredContent: {
					stdout: JSON.stringify({ value: "", exitCode: 0 }),
					exitCode: 0,
				},
			};
		},
		() => {
			fatal = true;
		},
	);
	const kb: KbDb = {
		async query<T>(sql: string, params: unknown[] = []) {
			expect(params).toContain("member");
			let rows: unknown[];
			if (sql.includes("FROM content_asset")) {
				expect(params[0]).toBe("42");
				rows = [{ kb_document_id: "inside" }];
			} else if (sql.includes("AS total")) {
				expect(params).toContain("inside");
				rows = [{ total: 1, documents: [] }];
			} else if (sql.includes("ts_rank_cd")) {
				expect(params).toContain("inside");
				rows = [
					{
						passage_id: "p",
						document_id: "inside",
						title: "Scoped",
						snippet: "needle",
					},
				];
			} else {
				expect(params[0]).toBe("inside");
				rows = [
					{
						document_id: "inside",
						title: "Scoped",
						content: "needle",
						content_length: 6,
					},
				];
			}
			return rows as T[];
		},
	};
	const server = createDocs(
		createScopedDocumentClient({
			kb,
			userId: "member",
			scope: { type: "document", summaryId: "42" },
			logger: { info() {}, error() {} },
		}),
		hand,
		new AbortController().signal,
	);
	const client = new Client({ name: "test", version: "1" });
	const [left, right] = InMemoryTransport.createLinkedPair();
	await server.instance.connect(left);
	await client.connect(right);
	const call = async (name: string, args: object) =>
		client.callTool({ name, arguments: args });
	try {
		expect(
			(await client.listTools()).tools.map((t: { name: string }) => t.name),
		).toEqual(["ListDocuments", "SearchDocuments", "LoadDocuments"]);
		expect(
			JSON.parse((await call("ListDocuments", {})).content[0].text).total,
		).toBe(1);
		expect(
			JSON.parse(
				(await call("SearchDocuments", { query: "needle" })).content[0].text,
			).passages[0].documentId,
		).toBe("inside");
		const loaded = JSON.parse(
			(await call("LoadDocuments", { documentIds: ["inside", "outside"] }))
				.content[0].text,
		);
		expect(loaded.loaded).toEqual([
			{
				documentId: "inside",
				title: "Scoped",
				path: "/ws/.mymemo/docs/inside.md",
				bytes: 6,
				truncated: false,
			},
		]);
		expect(loaded.errors).toHaveLength(1);
		expect(JSON.stringify(loaded)).not.toContain("needle");
		expect(writes).toEqual([
			[{ path: "ws/.mymemo/docs/inside.md", text: "needle" }],
		]);
		expect(
			(
				await call("SearchDocuments", {
					query: "needle",
					scope: { type: "general" },
				})
			).isError,
		).toBe(false);
		dead = true;
		await call("LoadDocuments", { documentIds: ["inside"] });
		expect(fatal).toBe(true);
	} finally {
		await client.close();
	}
});
