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
 * - `canUseTool` denies anything not pre-approved, so an unexpected or injected
 *   tool call cannot run under `permissionMode: "default"`.
 *
 * Bash REMAINS available: this is a general workspace agent that runs code,
 * manipulates files under `work/`, and produces artifacts under `output/` — not
 * a pure document-Q&A bot. `mcp__mymemo__search_documents` replaces only the
 * *document-fetch* use of Bash (the `mymemo-docs` CLI), not general computation,
 * so removing Bash would cripple the agent's actual job.
 *
 * Allowed Bash command surface: unrestricted. The boundary is OS-level sandbox
 * isolation, not a command allowlist — the agent runs under bwrap (read-only
 * root, tmpfs workspace, unshared user/pid/uts/ipc namespaces) inside an E2B
 * sandbox, with a scrubbed environment that holds no provider key, no DB
 * credential, and only short-lived per-turn gateway tokens (see `child-spawn.ts`,
 * covered by `child-spawn.test.ts`). A command allowlist would cripple a general
 * agent while adding little over that isolation, so the isolation is the
 * documented, tested compensating control.
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
 * Built-in tools the agent may use: `Bash` for general workspace work (running
 * code, writing files under `work/`/`output/`), and `Read`/`Grep`/`Glob` for the
 * local hydrated working set. See the file header for why Bash stays. Every
 * other built-in (`Write`, `Edit`, `WebFetch`, `Task`, …) is absent by omission
 * from this list, and `canUseTool` denies anything off it.
 */
export const ALLOWED_BUILTIN_TOOLS = ["Bash", "Read", "Grep", "Glob"] as const;

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
