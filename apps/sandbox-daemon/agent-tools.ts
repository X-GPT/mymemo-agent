/**
 * Claude Agent SDK tool surface and permission policy for the sandbox agent.
 *
 * Security boundary: the agent runs prompt-injectable, untrusted code; the real
 * containment is the sandbox itself (per-turn E2B in prod, the daemon's container
 * locally) with a scrubbed env holding no provider key, no DB credential, only
 * short-lived per-turn tokens (see `child-spawn.ts`). Because `Bash` is on the
 * surface, that isolation — not this tool list — bounds the agent: Bash already
 * subsumes file writes and network egress (`curl`).
 *
 * So this module is behavior-scoping, not the wall: pin the agent to a
 * reasoned-about set instead of the full Claude Code default, and keep
 * `permissionMode` off `bypassPermissions`.
 *  - `tools` pins availability (not pre-approval).
 *  - `allowedTools` pre-approves that set + the MyMemo MCP tool, so unattended
 *    turns run without prompts.
 *  - `canUseTool` denies anything off the list — hygiene, not containment.
 *
 * Surface: `Bash` for workspace work; `Read`/`Grep`/`Glob` for the local set;
 * `Write`/`Edit` for authoring under `work/`/`output/`;
 * `mcp__mymemo__search_documents` for documents. Omitted: `WebFetch`/`WebSearch`
 * (answer from MyMemo docs, not the web — soft default, Bash+curl is still a hole)
 * and `Task` (unneeded).
 */

import {
	type CanUseTool,
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadHydrationLimits } from "./hydration-policy";
import { searchAndHydrate } from "./search-documents";

/** MCP server name; the agent sees its tools as `mcp__<server>__<tool>`. */
export const MYMEMO_MCP_SERVER_NAME = "mymemo";

/** Unqualified name of the single document operation. */
export const SEARCH_DOCUMENTS_TOOL_NAME = "search_documents";

/** Fully-qualified, agent-facing name of the document tool. */
export const SEARCH_DOCUMENTS_TOOL = `mcp__${MYMEMO_MCP_SERVER_NAME}__${SEARCH_DOCUMENTS_TOOL_NAME}`;

/** Built-ins available to the agent (rationale + omissions in the file header). */
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
 * Default-deny permission handler: allow only pre-approved tools, deny the rest.
 * Rarely consulted (since `allowedTools` pre-approves the same set); it keeps
 * behavior scoped, NOT a containment boundary — Bash defeats that (see header).
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
 * Per-turn context the document tool needs: which conversation `docs/` dir to
 * write to, and which run to attribute hydration to. Threaded in from the daemon
 * so this module reads no env for paths/identity (the gateway URL + token are read
 * from per-turn env in the handler).
 */
export interface MymemoToolContext {
	/** Absolute path to the conversation's `docs/` dir. */
	docsDir: string;
	/** The run that owns this turn (recorded in the docs manifest). */
	runId: string;
}

function toolError(message: string): {
	content: { type: "text"; text: string }[];
	isError: true;
} {
	return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The MyMemo MCP tool definitions for the in-process server. The single
 * `search_documents` operation runs the search → fetch → hydrate → manifest flow
 * (see search-documents.ts); the gateway URL + (aud: "documents") token come from
 * per-turn env, the `docs/` dir + run id via {@link MymemoToolContext}.
 *
 * Expected failures (gateway errors, missing env/context) return a recoverable
 * tool error (`isError: true`) so the agent can retry instead of crashing the
 * query loop. No matches is a normal empty result.
 */
export function buildMymemoTools(context?: MymemoToolContext) {
	return [
		tool(
			SEARCH_DOCUMENTS_TOOL_NAME,
			"Search the user's MyMemo documents and hydrate matches into the local conversation workspace. Returns one row per document with its documentId, source, title, snippet, and localPath — a file you can Read.",
			{
				query: z
					.string()
					.min(1)
					.describe("What to search the user's MyMemo documents for."),
			},
			async ({ query }) => {
				const gatewayUrl = process.env.MYMEMO_DOC_GATEWAY_URL;
				const token = process.env.MYMEMO_DOC_TOKEN;
				if (!gatewayUrl || !token) {
					return toolError(
						"Document gateway is not configured for this turn (missing MYMEMO_DOC_GATEWAY_URL / MYMEMO_DOC_TOKEN).",
					);
				}
				if (!context) {
					return toolError(
						"Document workspace is not configured for this turn.",
					);
				}
				try {
					const documents = await searchAndHydrate(query, {
						gatewayUrl,
						token,
						docsDir: context.docsDir,
						runId: context.runId,
						limits: loadHydrationLimits(),
					});
					if (documents.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: "No MyMemo documents matched the query.",
								},
							],
						};
					}
					return {
						content: [
							{ type: "text", text: JSON.stringify({ documents }, null, 2) },
						],
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return toolError(`Document search failed: ${message}`);
				}
			},
		),
	];
}

/**
 * Register the MyMemo in-process MCP server exposing the document tool(s), so
 * `mcp__mymemo__search_documents` is available to the agent. `context` is
 * forwarded to the tool handler; omit it only where the surface is inspected
 * without being run (tests, registration checks).
 */
export function createMymemoMcpServer(
	context?: MymemoToolContext,
): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: MYMEMO_MCP_SERVER_NAME,
		version: "0.1.0",
		tools: buildMymemoTools(context),
	});
}
