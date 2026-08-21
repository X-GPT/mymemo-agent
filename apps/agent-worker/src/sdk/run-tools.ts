import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	type SdkMcpToolDefinition,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { type ZodRawShape, z } from "zod";
import {
	type BashToolLimits,
	type CommandAuditEvent,
	runBashTool,
	type SandboxCommandClient,
} from "../bash-tool/bash-tool";
import type { ScopedDocumentQueryClient } from "../documents/client";
import { runListDocumentsTool } from "../documents/list-documents-tool";
import { runLoadDocumentsTool } from "../documents/load-documents-tool";
import type { FrozenConversationScope } from "../documents/scope";
import { runSearchDocumentsTool } from "../documents/search-documents-tool";
import {
	type FileToolLimits,
	runEditFileTool,
	runGlobFileTool,
	runGrepFileTool,
	runReadFileTool,
	runWriteFileTool,
	type SandboxFileClient,
} from "../file-tools/file-tools";
import {
	PRESENT_UI_TOOL_DESCRIPTION,
	PRESENT_UI_TOOL_NAME,
	runPresentUiTool,
} from "../present-ui-tool";
import type { RunBinding } from "../sandbox-env";
import { UI_NODE_ROOT_SCHEMA } from "../ui-payload-validator";

/**
 * The MCP tool-result shape an SDK tool handler must resolve to, derived from
 * the SDK's own tool-definition type so we never import `@modelcontextprotocol`
 * directly (it is a transitive dependency, not a declared one).
 */
type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

/** The result shape every executor tool implementation already returns. */
interface ExecutorToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

/**
 * Adapt an executor tool result to the SDK's `CallToolResult`. A fresh object
 * literal is required so it satisfies `CallToolResult`'s index signature; the
 * executor result types carry none.
 */
function toCallToolResult(result: ExecutorToolResult): CallToolResult {
	return result.isError
		? { content: result.content, isError: true }
		: { content: result.content };
}

/** The in-process MCP server name every executor tool is exposed under. */
export const EXECUTOR_SERVER_NAME = "mymemo-executor";

/** The short names of the executor tools {@link buildRunTools} builds. */
const EXECUTOR_TOOL_NAMES = [
	"Read",
	"Write",
	"Edit",
	"Grep",
	"Glob",
	"Bash",
	"ListDocuments",
	"SearchDocuments",
	"LoadDocuments",
	PRESENT_UI_TOOL_NAME,
] as const;

/**
 * Expose one schema to the model while preserving the raw value at runtime.
 * The MCP SDK otherwise parses away malformed input before PresentUI can return
 * the validator's typed repair rule. This Zod hook is pinned by the model-schema
 * and MCP-handler regression tests and by the exact Zod version in package.json.
 */
function modelSchemaWithRawRuntime<T extends z.ZodType>(modelSchema: T) {
	const runtimeSchema = z.object({}).passthrough();
	runtimeSchema._zod.toJSONSchema = () => {
		const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(modelSchema, {
			target: "draft-7",
		});
		return { ...jsonSchema, type: "object" };
	};
	return runtimeSchema;
}

// The Claude SDK types tool input as a raw shape even though the MCP runtime
// accepts a full Zod object. The runtime object preserves every direct UiNode
// field for authoritative validation while the model sees the catalog schema.
const PRESENT_UI_INPUT_SCHEMA = modelSchemaWithRawRuntime(UI_NODE_ROOT_SCHEMA);

/**
 * The fail-closed query allowlist (ADR-0006): exactly the executor tools, in
 * the `mcp__<server>__<tool>` form the SDK's `allowedTools` matches against.
 * Any tool outside this list is denied under `permissionMode: 'dontAsk'` —
 * never prompted, never executed. A test pins this to what
 * {@link buildRunTools} actually builds so the two cannot drift.
 */
export const EXECUTOR_ALLOWED_TOOLS: readonly string[] =
	EXECUTOR_TOOL_NAMES.map((name) => `mcp__${EXECUTOR_SERVER_NAME}__${name}`);

/**
 * Everything one claimed run needs to expose its executor tools to the Claude
 * Agent SDK. Assembled per run from the run binding, the provisioned sandbox
 * clients, the frozen document scope, and the worker's caps. The tools built
 * from it close over the binding, so every file, shell, and document action the
 * model takes is attributed to the exact `{userId, conversationId, runId,
 * sandboxId}` that caused it (plan Task 7.2).
 */
export interface RunToolDeps {
	binding: RunBinding;
	/** Absolute sandbox workspace root; all file/shell paths resolve under it. */
	workspaceRoot: string;
	/** Fires on interruption/ownership-loss/shutdown; a running Bash command is killed. */
	signal: AbortSignal;
	fileClient: SandboxFileClient;
	commandClient: SandboxCommandClient;
	documentClient: ScopedDocumentQueryClient;
	documentScope: FrozenConversationScope;
	fileLimits: FileToolLimits;
	bashLimits: BashToolLimits;
	documentSearchMaxResults: number;
	documentListMaxResults: number;
	documentLoad: {
		maxDocuments: number;
		perDocumentMaxBytes: number;
		perCallMaxBytes: number;
	};
	markSandboxTainted(reason: string): Promise<void>;
	recordCommandAudit(event: CommandAuditEvent): Promise<void>;
}

/** The document-access binding is the run binding minus the sandbox id: document
 * search is trusted worker-side work, never reachable from the sandbox. */
function documentBinding(binding: RunBinding) {
	return {
		userId: binding.userId,
		conversationId: binding.conversationId,
		runId: binding.runId,
	};
}

/**
 * Build the model-facing executor tools for one run, each bound to the run's
 * binding, sandbox clients, and scope. The handlers delegate to the already
 * path-, byte-, and timeout-bounded tool implementations; this module only wires
 * the per-run context, so tool safety stays defined in one place.
 */
// biome-ignore lint/suspicious/noExplicitAny: a per-run tool set is heterogeneous by construction; the SDK's own CreateSdkMcpServerOptions.tools is likewise Array<SdkMcpToolDefinition<any>>.
export function buildRunTools(deps: RunToolDeps): SdkMcpToolDefinition<any>[] {
	const fileContext = {
		client: deps.fileClient,
		workspaceRoot: deps.workspaceRoot,
		limits: deps.fileLimits,
	};

	return [
		tool(
			"Read",
			"Read a UTF-8 text file from the run workspace, with optional line offset/limit.",
			{
				path: z.string(),
				offset: z.number().optional(),
				limit: z.number().optional(),
			},
			async (input) =>
				toCallToolResult(await runReadFileTool(input, fileContext)),
		),
		tool(
			"Write",
			"Create or overwrite a file in the run workspace with the given content.",
			{ path: z.string(), content: z.string() },
			async (input) =>
				toCallToolResult(await runWriteFileTool(input, fileContext)),
		),
		tool(
			"Edit",
			"Replace every occurrence of oldText with newText in a workspace file.",
			{ path: z.string(), oldText: z.string(), newText: z.string() },
			async (input) =>
				toCallToolResult(await runEditFileTool(input, fileContext)),
		),
		tool(
			"Grep",
			"Search file contents in the run workspace for a pattern.",
			{
				pattern: z.string(),
				path: z.string().optional(),
				include: z.string().optional(),
				caseSensitive: z.boolean().optional(),
				maxResults: z.number().optional(),
			},
			async (input) =>
				toCallToolResult(await runGrepFileTool(input, fileContext)),
		),
		tool(
			"Glob",
			"List workspace files matching a glob pattern.",
			{
				pattern: z.string(),
				path: z.string().optional(),
				includeHidden: z.boolean().optional(),
				maxResults: z.number().optional(),
			},
			async (input) =>
				toCallToolResult(await runGlobFileTool(input, fileContext)),
		),
		tool(
			"Bash",
			"Run a foreground shell command in the run workspace and return its output.",
			{
				command: z.string(),
				cwd: z.string().optional(),
				timeoutMs: z.number().optional(),
			},
			async (input) =>
				toCallToolResult(
					await runBashTool(input, {
						client: deps.commandClient,
						workspaceRoot: deps.workspaceRoot,
						binding: deps.binding,
						limits: deps.bashLimits,
						signal: deps.signal,
						markSandboxTainted: deps.markSandboxTainted,
						recordCommandAudit: deps.recordCommandAudit,
					}),
				),
		),
		tool(
			"ListDocuments",
			"Count and browse the searchable documents in this conversation's scope, newest first.",
			{ limit: z.number().optional(), cursor: z.string().optional() },
			async (input) =>
				toCallToolResult(
					await runListDocumentsTool(input, {
						client: deps.documentClient,
						binding: documentBinding(deps.binding),
						scope: deps.documentScope,
						maxResults: deps.documentListMaxResults,
					}),
				),
		),
		tool(
			"SearchDocuments",
			"Search the MyMemo knowledge base within this conversation's scope for relevant passages.",
			{ query: z.string(), maxResults: z.number().optional() },
			async (input) =>
				toCallToolResult(
					await runSearchDocumentsTool(input, {
						client: deps.documentClient,
						binding: documentBinding(deps.binding),
						scope: deps.documentScope,
						maxResults: deps.documentSearchMaxResults,
					}),
				),
		),
		tool(
			"LoadDocuments",
			"Materialize scoped MyMemo documents as files in the workspace docs cache and return their paths.",
			{ documentIds: z.array(z.string()) },
			async (input) =>
				toCallToolResult(
					await runLoadDocumentsTool(input, {
						client: deps.documentClient,
						sandbox: deps.fileClient,
						binding: documentBinding(deps.binding),
						scope: deps.documentScope,
						workspaceRoot: deps.workspaceRoot,
						limits: deps.documentLoad,
					}),
				),
		),
		tool(
			PRESENT_UI_TOOL_NAME,
			PRESENT_UI_TOOL_DESCRIPTION,
			PRESENT_UI_INPUT_SCHEMA as unknown as ZodRawShape,
			async (input) => toCallToolResult(runPresentUiTool(input)),
		),
	];
}

/**
 * Wrap the run's bound tools in an in-process SDK MCP server, the form
 * `query({ options: { mcpServers } })` accepts. The server runs inside the
 * trusted worker; no credential crosses into the sandbox.
 */
export function createRunMcpServer(
	deps: RunToolDeps,
): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: EXECUTOR_SERVER_NAME,
		tools: buildRunTools(deps),
		// The SDK can defer MCP connections. Every executor tool must be
		// available to the model on its first turn.
		alwaysLoad: true,
	});
}
