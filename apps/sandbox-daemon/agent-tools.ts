/**
 * Claude Agent SDK tool surface and permission policy for the sandbox agent.
 *
 * The agent runs prompt-injectable, untrusted code, so its tool surface is
 * pinned explicitly instead of relying on `permissionMode: "bypassPermissions"`.
 * The SDK separates tool *availability* from tool *pre-approval*, so we use both
 * layers plus a fail-closed catch-all:
 *
 * - `tools` pins the available built-ins (availability, not pre-approval).
 * - `allowedTools` pre-approves exactly that set plus the MyMemo MCP tool.
 * - `disallowedTools` hard-denies `Bash`, even if a future change widens `tools`.
 * - `canUseTool` denies anything not pre-approved, so an unexpected or injected
 *   tool call cannot run.
 *
 * Bash is intentionally absent from the surface. Its only purpose was the
 * `mymemo-docs` CLI for document access, which `mcp__mymemo__search_documents`
 * replaces; dropping it shrinks the untrusted agent's blast radius. The agent
 * reads the local hydrated working set with `Read`/`Grep`/`Glob` and reaches the
 * remote corpus only through the MyMemo MCP tool.
 */

import {
	type CanUseTool,
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	type SdkMcpToolDefinition,
	tool,
} from "@anthropic-ai/claude-agent-sdk";

/** MCP server name; the agent sees its tools as `mcp__<server>__<tool>`. */
export const MYMEMO_MCP_SERVER_NAME = "mymemo";

/** Unqualified name of the single document operation. */
export const SEARCH_DOCUMENTS_TOOL_NAME = "search_documents";

/** Fully-qualified, agent-facing name of the document tool. */
export const SEARCH_DOCUMENTS_TOOL = `mcp__${MYMEMO_MCP_SERVER_NAME}__${SEARCH_DOCUMENTS_TOOL_NAME}`;

/**
 * Built-in tools the agent may use, for reading the local hydrated working set.
 * Bash is deliberately excluded (see file header).
 */
export const ALLOWED_BUILTIN_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Built-ins explicitly denied as defense-in-depth. `tools` already makes every
 * other built-in unavailable; we additionally deny `Bash` by name so a future
 * widening of `tools` cannot silently re-expose the highest-risk built-in.
 */
export const DISALLOWED_BUILTIN_TOOLS = ["Bash"] as const;

/** Every tool the agent is pre-approved to call without prompting. */
export const PRE_APPROVED_TOOLS = [
	...ALLOWED_BUILTIN_TOOLS,
	SEARCH_DOCUMENTS_TOOL,
] as const;

/**
 * Fail-closed permission handler: allow only pre-approved tools, deny everything
 * else with a clear message. With `allowedTools` pre-approving the same set this
 * is rarely consulted, but it is the backstop that keeps an unexpected or
 * prompt-injected tool call from running under `permissionMode: "default"`.
 */
export function createCanUseTool(
	preApproved: readonly string[] = PRE_APPROVED_TOOLS,
): CanUseTool {
	const allowed = new Set(preApproved);
	return async (toolName, input) => {
		if (allowed.has(toolName)) {
			return { behavior: "allow", updatedInput: input };
		}
		return {
			behavior: "deny",
			message: `Tool "${toolName}" is not permitted for the MyMemo sandbox agent.`,
		};
	};
}

/**
 * The MyMemo MCP tool definitions registered with the in-process server.
 *
 * Today this is the single document operation. Its handler is a placeholder:
 * the real search → fetch → hydrate → manifest flow is implemented in MYM-11
 * (Task 7). Until then it returns a recoverable tool error (`isError: true`) so
 * a premature call fails in a way the agent can explain, rather than silently
 * returning nothing.
 */
export function buildMymemoTools(): SdkMcpToolDefinition[] {
	return [
		tool(
			SEARCH_DOCUMENTS_TOOL_NAME,
			"Search the user's MyMemo documents and hydrate matches into the local conversation workspace. Returns snippets plus local file paths.",
			{},
			async () => ({
				content: [
					{
						type: "text",
						text: "search_documents is not implemented yet (pending MYM-11).",
					},
				],
				isError: true,
			}),
		),
	];
}

/**
 * Register the MyMemo in-process MCP server exposing the document tool(s), so
 * `mcp__mymemo__search_documents` is available to the agent.
 */
export function createMymemoMcpServer(): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: MYMEMO_MCP_SERVER_NAME,
		version: "0.1.0",
		tools: buildMymemoTools(),
	});
}
