/**
 * Claude Agent SDK tool surface and permission policy for the sandbox agent.
 *
 * Security boundary: the agent runs prompt-injectable, untrusted code, and the
 * real containment is the sandbox itself — the per-turn E2B sandbox in prod (the
 * daemon's container locally), with a scrubbed env holding no provider key, no
 * DB credential, and only short-lived per-turn gateway tokens (see
 * `child-spawn.ts`, covered by `child-spawn.test.ts`). Because `Bash` is on the
 * surface (below), that isolation — not this tool list — is what bounds what the
 * agent can do; Bash already subsumes file writes and network egress (`curl`).
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
 * file header); the sandbox/container is the boundary.
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
 * Per-turn context the document tool needs to hydrate into the right place:
 * which conversation `docs/` dir to write to, and which run to attribute the
 * hydration to in the manifest. Threaded in from the daemon (see agent.ts) so
 * this module reads no environment for paths/identity. The gateway URL + bearer
 * token are read from the per-turn env inside the handler instead.
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
 * The MyMemo MCP tool definitions registered with the in-process server.
 *
 * The single `search_documents` operation runs the search → fetch → hydrate →
 * manifest flow (see search-documents.ts). The gateway URL + (aud: "documents")
 * token come from the per-turn env the daemon set on the agent process; the
 * conversation `docs/` dir and run id arrive via {@link MymemoToolContext}.
 *
 * Expected failures — gateway errors, or a missing env/context (a premature call
 * before the turn is wired) — return a recoverable tool error (`isError: true`)
 * so the agent can retry or explain, rather than throwing and crashing the query
 * loop. No matches is a normal (non-error) empty result.
 */
export function buildMymemoTools(context?: MymemoToolContext) {
	return [
		tool(
			SEARCH_DOCUMENTS_TOOL_NAME,
			'Search the user\'s MyMemo documents and hydrate matches into the local conversation workspace. Returns one row per document with its documentId, source, title, snippet, and localPath. A non-empty localPath is a file you can Read; if source is "skipped_too_large" or "skipped_run_budget" the document was not hydrated, localPath is empty, and the row\'s `error` says which limit was hit.',
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
