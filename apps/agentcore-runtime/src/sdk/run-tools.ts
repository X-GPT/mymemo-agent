import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	type SdkMcpToolDefinition,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { type ZodRawShape, z } from "zod";
import type { ScopedDocumentQueryClient } from "../documents/client";
import { runListDocumentsTool } from "../documents/list-documents-tool";
import { runLoadDocumentsTool } from "../documents/load-documents-tool";
import type { FrozenConversationScope } from "../documents/scope";
import { runSearchDocumentsTool } from "../documents/search-documents-tool";
import {
	PRESENT_UI_TOOL_DESCRIPTION,
	PRESENT_UI_TOOL_NAME,
	runPresentUiTool,
} from "../present-ui-tool";
import type { RunBinding } from "../sandbox-env";
import { UI_NODE_ROOT_SCHEMA } from "../ui-payload-validator";
import {
	buildWorkspaceTools,
	EXECUTOR_SERVER_NAME,
	toCallToolResult,
	WORKSPACE_EXECUTOR_TOOL_NAMES,
	type WorkspaceToolDeps,
} from "./workspace-tools";

/** The in-process MCP server name every executor tool is exposed under. */
export { EXECUTOR_SERVER_NAME } from "./workspace-tools";

/** The short names of the executor tools {@link buildRunTools} builds. */
const EXECUTOR_TOOL_NAMES = [
	...WORKSPACE_EXECUTOR_TOOL_NAMES,
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
	const runtimeSchema = z.looseObject({});
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
 * Everything one acquired Run needs to expose its executor tools to the Claude
 * Agent SDK. Assembled per run from the run binding, the provisioned sandbox
 * clients, the frozen document scope, and the Runtime's caps. The tools built
 * from it close over the binding, so every file, shell, and document action the
 * model takes is attributed to the exact `{userId, conversationId, runId,
 * sandboxId}` that caused it (plan Task 7.2).
 */
export interface RunToolDeps extends WorkspaceToolDeps {
	documentClient: ScopedDocumentQueryClient;
	documentScope: FrozenConversationScope;
	documentSearchMaxResults: number;
	documentListMaxResults: number;
	documentLoad: {
		maxDocuments: number;
		perDocumentMaxBytes: number;
		perCallMaxBytes: number;
	};
}

/** The document-access binding is the run binding minus the sandbox id: document
 * search is trusted Runtime-side work, never reachable from the sandbox. */
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
	return [
		...buildWorkspaceTools(deps),
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
 * trusted Runtime; no credential crosses into the sandbox.
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
