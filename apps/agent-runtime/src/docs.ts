import type { ScopedDocumentClient } from "@mymemo/document-tools/client";
import {
	DOCUMENT_TOOL_DESCRIPTIONS,
	DOCUMENT_TOOL_NAMES,
	type DocsCacheWriter,
	listDocuments,
	loadDocuments,
	searchDocuments,
} from "@mymemo/document-tools/tools";
import { createSdkMcpServer, tool } from "claude-agent-sdk";
import { z } from "zod";

export const docsToolAliases = Object.fromEntries(
	DOCUMENT_TOOL_NAMES.map((name) => [name, `mcp__docs__${name}`]),
);

export function createDocs(
	client: ScopedDocumentClient,
	sandbox: DocsCacheWriter,
	abortSignal: AbortSignal,
) {
	function define<Shape extends z.ZodRawShape>(
		name: (typeof DOCUMENT_TOOL_NAMES)[number],
		schema: Shape,
		handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<object>,
	) {
		return tool(
			name,
			DOCUMENT_TOOL_DESCRIPTIONS[name],
			schema,
			async (args) => {
				const result = await handler(z.strictObject(schema).parse(args));
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					isError: "isError" in result && result.isError === true,
				};
			},
		);
	}
	return createSdkMcpServer({
		name: "docs",
		alwaysLoad: true,
		tools: [
			define(
				"ListDocuments",
				{
					limit: z.number().int().positive().optional(),
					cursor: z.string().optional(),
				},
				(args) => listDocuments(args, client),
			),
			define(
				"SearchDocuments",
				{
					query: z.string().min(1),
					maxResults: z.number().int().positive().optional(),
				},
				(args) => searchDocuments(args, client),
			),
			define(
				"LoadDocuments",
				{ documentIds: z.array(z.string()).min(1).max(10) },
				(args) =>
					loadDocuments(args, { client, sandbox, workDir: "/ws", abortSignal }),
			),
		],
	});
}
