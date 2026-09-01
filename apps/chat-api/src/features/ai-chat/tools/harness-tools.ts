import type { HarnessAgentSandboxConfig } from "@ai-sdk/harness/agent";
import type {
	DocumentToolBinding,
	DocumentToolLogger,
	ScopedDocumentClient,
} from "@mymemo/document-tools/client";
import {
	DOCUMENT_TOOL_DESCRIPTIONS,
	DOCUMENT_TOOL_NAMES,
	type ListDocumentsInput,
	type LoadDocumentsInput,
	listDocuments,
	loadDocuments,
	type SearchDocumentsInput,
	searchDocuments,
	type ToolFailure,
} from "@mymemo/document-tools/tools";
import { z } from "zod";

/** Short names of the Harness user tools — executed by chat-api on the AI SDK chat path. */
export const HARNESS_TOOL_NAMES = DOCUMENT_TOOL_NAMES;

/** Claude Code built-ins on in the Harness sandbox, by adapter common name (ADR-0033 stage 2). */
export const HARNESS_BUILTIN_TOOLS = ["read", "write", "edit", "grep"] as const;

/** Everything the per-turn `HarnessAgent` may call. */
export const HARNESS_ACTIVE_TOOLS = [
	...HARNESS_BUILTIN_TOOLS,
	...HARNESS_TOOL_NAMES,
] as const;

type OnSession = NonNullable<HarnessAgentSandboxConfig["onSession"]>;
/** The restricted Harness-sandbox session `execute()` receives as `experimental_sandbox`. */
export type HarnessSandboxSession = Parameters<OnSession>[0]["session"];

/** What the bridge hands every user-tool `execute()`; `messages` is always empty. */
interface ExecuteOptions {
	abortSignal?: AbortSignal;
	experimental_sandbox?: HarnessSandboxSession;
}

/** Plain JSON resolves; a handler failure rejects so the model gets an `is_error` result. */
async function unwrap<T>(result: Promise<T | ToolFailure>): Promise<T> {
	const value = await result;
	if (typeof value === "object" && value !== null && "isError" in value) {
		throw new Error(value.text);
	}
	return value;
}

/**
 * The document tools for one Harness turn, closed over that turn's scoped
 * client and binding (`messages` is never read). `LoadDocuments` writes
 * through the session it is handed; the other two never touch it.
 */
export function createHarnessTools(deps: {
	client: ScopedDocumentClient;
	binding: DocumentToolBinding;
	logger: DocumentToolLogger;
}) {
	let workDir: string | undefined;
	// For `sandboxConfig.onSession`: runs for fresh and resumed sessions before the turn.
	const onSession: OnSession = async ({ sessionWorkDir }) => {
		workDir = sessionWorkDir;
	};
	const log = (tool: (typeof HARNESS_TOOL_NAMES)[number]) =>
		deps.logger.info({ ...deps.binding, tool }, "harness document tool call");
	const tools = {
		ListDocuments: {
			description: DOCUMENT_TOOL_DESCRIPTIONS.ListDocuments,
			inputSchema: z.object({
				limit: z.number().optional(),
				cursor: z.string().optional(),
			}),
			execute: (input: ListDocumentsInput) => {
				log("ListDocuments");
				return unwrap(listDocuments(input, deps.client));
			},
		},
		SearchDocuments: {
			description: DOCUMENT_TOOL_DESCRIPTIONS.SearchDocuments,
			inputSchema: z.object({
				query: z.string(),
				maxResults: z.number().optional(),
			}),
			execute: (input: SearchDocumentsInput) => {
				log("SearchDocuments");
				return unwrap(searchDocuments(input, deps.client));
			},
		},
		LoadDocuments: {
			description: DOCUMENT_TOOL_DESCRIPTIONS.LoadDocuments,
			inputSchema: z.object({ documentIds: z.array(z.string()) }),
			execute: async (
				input: LoadDocumentsInput,
				{ abortSignal, experimental_sandbox }: ExecuteOptions,
			) => {
				log("LoadDocuments");
				if (!experimental_sandbox || !workDir) {
					throw new Error(
						"LoadDocuments failed: no sandbox session for this turn",
					);
				}
				return unwrap(
					loadDocuments(input, {
						client: deps.client,
						sandbox: experimental_sandbox,
						workDir,
						abortSignal,
					}),
				);
			},
		},
	};
	return { tools, onSession };
}
