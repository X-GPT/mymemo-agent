import type { HarnessAgentSandboxConfig } from "@ai-sdk/harness/agent";
import { z } from "zod";
import type {
	HarnessToolBinding,
	HarnessToolLogger,
	ScopedDocumentClient,
} from "./document-client";
import {
	type ListDocumentsInput,
	type LoadDocumentsInput,
	listDocuments,
	loadDocuments,
	type SearchDocumentsInput,
	searchDocuments,
	type ToolFailure,
} from "./document-tools";

/** Short names of the Harness user tools — executed by chat-api on the AI SDK chat path. */
export const HARNESS_TOOL_NAMES = [
	"ListDocuments",
	"SearchDocuments",
	"LoadDocuments",
] as const;

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
	binding: HarnessToolBinding;
	logger: HarnessToolLogger;
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
			description:
				"Count and browse the searchable documents in this conversation's scope, newest first.",
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
			description:
				"Search the MyMemo knowledge base within this conversation's scope for relevant passages.",
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
			description:
				"Materialize scoped MyMemo documents as files under .mymemo/docs in your working directory and return their paths, so you can Read or Grep them.",
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
