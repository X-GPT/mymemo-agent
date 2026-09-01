import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	type SdkMcpToolDefinition,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import { conversations } from "@mymemo/agent-db/schema";
import type { DocumentAccessLog } from "@mymemo/document-tools/access-log";
import {
	createScopedDocumentClient,
	type DocumentToolLogger,
	type FrozenScope,
	type KbDb,
	parseFrozenScope,
	type ScopedDocumentClient,
} from "@mymemo/document-tools/client";
import {
	DOCUMENT_TOOL_DESCRIPTIONS,
	DOCUMENT_TOOL_NAMES,
	type DocsCacheWriter,
	listDocuments,
	loadDocuments,
	searchDocuments,
	type ToolFailure,
} from "@mymemo/document-tools/tools";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

/**
 * The document tools as in-process MCP (spec #654, ticket #665): the handlers
 * run in this trusted process — Scope-enforced KB SQL, docs-cache
 * materialization into the Workspace, one audit row per call — and the spawned
 * CLI only ever sees the tool surface, never a KB credential.
 */

/** The in-process MCP server name the document tools are exposed under. */
export const DOC_TOOLS_SERVER_NAME = "mymemo-docs";

/**
 * The document tools in the `mcp__<server>__<tool>` form `allowedTools`
 * matches against. A test pins this to what {@link buildDocTools} actually
 * builds so the two cannot drift.
 */
export const DOC_TOOLS_ALLOWED_TOOLS: readonly string[] =
	DOCUMENT_TOOL_NAMES.map((name) => `mcp__${DOC_TOOLS_SERVER_NAME}__${name}`);

/**
 * The Turn currently being served — turn-serving sets it around each claim, so
 * every audit row is attributed to the exact Turn whose `query()` made the
 * call. A shared mutable ref rather than a per-Turn server because the MCP
 * server is built once per VM (and #664's long-lived `query()` keeps it).
 */
export interface CurrentTurn {
	turnId: string | null;
}

export interface DocToolsDeps {
	/** Writable agent DB: the frozen-Scope read and the audit rows. */
	db: Database;
	kb: KbDb;
	audit: DocumentAccessLog;
	logger: DocumentToolLogger;
	userId: string;
	conversationId: string;
	/** The Workspace — LoadDocuments materializes under `<workspaceDir>/.mymemo/docs`. */
	workspaceDir: string;
	currentTurn: CurrentTurn;
}

type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

/** A fixed, model-safe failure; internal details go to the logger only. */
function failResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function toCallToolResult(result: object | ToolFailure): CallToolResult {
	if ("isError" in result && result.isError === true) {
		return failResult((result as ToolFailure).text);
	}
	return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

/** Plain local-FS writer: inside the VM the Workspace is this process's own disk. */
const localDocsCacheWriter: DocsCacheWriter = {
	async writeTextFile({ path: filePath, content }) {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf8");
	},
};

/**
 * Build the model-facing document tools, each resolving the Conversation's
 * frozen Scope and the in-flight Turn at call time. The handlers delegate to
 * the shared `@mymemo/document-tools` implementations; this module only wires
 * the per-VM context.
 */
// biome-ignore lint/suspicious/noExplicitAny: the SDK's own CreateSdkMcpServerOptions.tools is Array<SdkMcpToolDefinition<any>>.
export function buildDocTools(deps: DocToolsDeps): SdkMcpToolDefinition<any>[] {
	// The Scope is frozen at Conversation creation (immutable for its lifetime),
	// so one successful read serves the whole process. Resolved lazily rather
	// than at boot so a local server may start before its Conversation row.
	let scope: FrozenScope | undefined;
	async function frozenScope(): Promise<FrozenScope> {
		if (scope) return scope;
		const [row] = await deps.db
			.select({
				scope: conversations.scope,
				collectionId: conversations.collectionId,
				summaryId: conversations.summaryId,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, deps.userId),
					eq(conversations.conversationId, deps.conversationId),
				),
			);
		if (!row) throw new Error("conversation row not found");
		scope = parseFrozenScope(row);
		return scope;
	}

	/** Bind a scoped client to the in-flight Turn, or fail closed. */
	async function withClient(
		toolName: (typeof DOCUMENT_TOOL_NAMES)[number],
		run: (client: ScopedDocumentClient) => Promise<object | ToolFailure>,
	): Promise<CallToolResult> {
		const turnId = deps.currentTurn.turnId;
		if (!turnId) {
			// Unreachable while tools only run inside a Turn's query(); fail
			// closed rather than write an unattributable audit row.
			return failResult(`${toolName} failed: no Turn is being served`);
		}
		deps.logger.info(
			{
				userId: deps.userId,
				conversationId: deps.conversationId,
				turnId,
				tool: toolName,
			},
			"document tool call",
		);
		let resolvedScope: FrozenScope;
		try {
			resolvedScope = await frozenScope();
		} catch (error) {
			deps.logger.error(
				{ err: error, conversationId: deps.conversationId, tool: toolName },
				"document tool: could not resolve the frozen Scope",
			);
			return failResult(
				`${toolName} failed: the conversation scope could not be resolved`,
			);
		}
		const client = createScopedDocumentClient({
			kb: deps.kb,
			audit: deps.audit,
			logger: deps.logger,
			binding: {
				userId: deps.userId,
				conversationId: deps.conversationId,
				turnId,
			},
			scope: resolvedScope,
		});
		return toCallToolResult(await run(client));
	}

	return [
		tool(
			"ListDocuments",
			DOCUMENT_TOOL_DESCRIPTIONS.ListDocuments,
			{ limit: z.number().optional(), cursor: z.string().optional() },
			(input) =>
				withClient("ListDocuments", (client) => listDocuments(input, client)),
		),
		tool(
			"SearchDocuments",
			DOCUMENT_TOOL_DESCRIPTIONS.SearchDocuments,
			{ query: z.string(), maxResults: z.number().optional() },
			(input) =>
				withClient("SearchDocuments", (client) =>
					searchDocuments(input, client),
				),
		),
		tool(
			"LoadDocuments",
			DOCUMENT_TOOL_DESCRIPTIONS.LoadDocuments,
			{ documentIds: z.array(z.string()) },
			(input) =>
				withClient("LoadDocuments", (client) =>
					loadDocuments(input, {
						client,
						sandbox: localDocsCacheWriter,
						workDir: deps.workspaceDir,
					}),
				),
		),
	];
}

/**
 * Wrap the bound document tools in an in-process SDK MCP server, the form
 * `query({ options: { mcpServers } })` accepts. The server runs inside the
 * trusted In-VM process; no credential crosses into the spawned CLI.
 */
export function createDocToolsServer(
	deps: DocToolsDeps,
): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: DOC_TOOLS_SERVER_NAME,
		tools: buildDocTools(deps),
		// The SDK can defer MCP connections. Every document tool must be
		// available to the model on its first Turn.
		alwaysLoad: true,
	});
}
