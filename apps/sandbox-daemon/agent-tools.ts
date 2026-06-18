/**
 * Claude Agent SDK tool surface and permission policy for the sandbox agent.
 *
 * Security boundary: the agent runs prompt-injectable, untrusted code, and the
 * real containment is OS-level — bwrap (read-only root, tmpfs workspace,
 * unshared user/pid/uts/ipc namespaces) inside an E2B sandbox, with a scrubbed
 * env holding no provider key, no DB credential, and only short-lived per-turn
 * gateway tokens (see `child-spawn.ts`, covered by `child-spawn.test.ts`).
 * Because `Bash` is on the surface (below), that isolation — not this tool
 * list — is what bounds what the agent can do; Bash already subsumes file
 * writes and network egress (`curl`).
 *
 * This module's job is therefore behavior-scoping, not the wall: pin the agent
 * to a predictable, reasoned-about set instead of the full Claude Code default,
 * and keep `permissionMode` off `bypassPermissions`.
 *
 * - `tools` pins the available built-ins (availability, not pre-approval).
 * - `allowedTools` pre-approves that set plus the MyMemo MCP tool, so an
 *   unattended turn runs without permission prompts.
 * - `canUseTool` denies anything off the list — hygiene so an injected prompt
 *   can't casually reach a first-class tool we never reasoned about. It is NOT
 *   a containment boundary (Bash defeats that); it just keeps behavior scoped.
 *
 * Surface rationale: `Bash` for general workspace work (running code, builds,
 * scripts); `Read`/`Grep`/`Glob` for the local working set; `Write`/`Edit` for
 * authoring files under `work/`/`output/` (more reliable than Bash heredocs, and
 * denying them buys nothing over Bash). `mcp__mymemo__search_documents` is the
 * document path. Deliberately omitted: `WebFetch`/`WebSearch` (the agent answers
 * from MyMemo documents, not the open web — a soft policy default, since
 * Bash+curl is still a hole) and `Task`/subagent orchestration (unneeded).
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
 * Built-in tools available to the agent (see the file header for the rationale
 * and what is deliberately omitted): `Bash` for general workspace work,
 * `Read`/`Grep`/`Glob` for the local working set, `Write`/`Edit` for authoring
 * files under `work/`/`output/`. Every other built-in (`WebFetch`, `WebSearch`,
 * `Task`, …) is absent by omission, and `canUseTool` denies anything off it.
 */
export const ALLOWED_BUILTIN_TOOLS = [
	"Bash",
	"Read",
	"Grep",
	"Glob",
	"Write",
	"Edit",
] as const;

/** Every tool the agent is pre-approved to call without prompting. */
export const PRE_APPROVED_TOOLS = [
	...ALLOWED_BUILTIN_TOOLS,
	SEARCH_DOCUMENTS_TOOL,
] as const;

/**
 * Default-deny permission handler: allow only pre-approved tools, deny everything
 * else with a clear message. With `allowedTools` pre-approving the same set it is
 * rarely consulted; it keeps the agent's behavior scoped to the reasoned-about
 * set under `permissionMode: "default"`. This is behavior-scoping, NOT a
 * containment boundary — `Bash` can already do what a denied tool would (see the
 * file header); the bwrap/E2B sandbox is the boundary.
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
