import type { HarnessAgentSandboxConfig } from "@ai-sdk/harness/agent";
import { z } from "zod";
import type {
	HarnessToolBinding,
	ScopedDocumentClient,
} from "./document-client";
import {
	listDocuments,
	loadDocuments,
	searchDocuments,
	type ToolFailure,
} from "./document-tools";

export type { HarnessToolBinding } from "./document-client";

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

export interface HarnessToolLogger {
	info(obj: object, msg: string): void;
}

export type HarnessTools = ReturnType<typeof buildTools>;

/** One turn's user tools plus the hook that tells them the session work directory. */
export interface HarnessTurnTools {
	tools: HarnessTools;
	/** For `sandboxConfig.onSession`: runs for fresh and resumed sessions before the turn. */
	onSession: OnSession;
}

/** Plain JSON resolves; a handler failure rejects so the model gets an `is_error` result. */
async function unwrap<T>(result: Promise<T | ToolFailure>): Promise<T> {
	const value = await result;
	if (typeof value === "object" && value !== null && "isError" in value) {
		throw new Error(value.text);
	}
	return value;
}

function buildTools(
	deps: {
		client: ScopedDocumentClient;
		binding: HarnessToolBinding;
		logger: HarnessToolLogger;
	},
	workDir: () => string | undefined,
) {
	const log = (tool: (typeof HARNESS_TOOL_NAMES)[number]) =>
		deps.logger.info({ ...deps.binding, tool }, "harness document tool call");
	return {
		ListDocuments: {
			description:
				"Count and browse the searchable documents in this conversation's scope, newest first.",
			inputSchema: z.object({
				limit: z.number().optional(),
				cursor: z.string().optional(),
			}),
			execute: (
				input: { limit?: number; cursor?: string },
				_options: ExecuteOptions,
			) => {
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
			execute: (
				input: { query: string; maxResults?: number },
				_options: ExecuteOptions,
			) => {
				log("SearchDocuments");
				return unwrap(searchDocuments(input, deps.client));
			},
		},
		LoadDocuments: {
			description:
				"Materialize scoped MyMemo documents as files under .mymemo/docs in your working directory and return their paths, so you can Read or Grep them.",
			inputSchema: z.object({ documentIds: z.array(z.string()) }),
			execute: (
				input: { documentIds: string[] },
				{ abortSignal, experimental_sandbox }: ExecuteOptions,
			) => {
				log("LoadDocuments");
				const dir = workDir();
				if (!experimental_sandbox || !dir) {
					throw new Error(
						"LoadDocuments failed: no sandbox session for this turn",
					);
				}
				return unwrap(
					loadDocuments(input, {
						client: deps.client,
						sandbox: experimental_sandbox,
						workDir: dir,
						abortSignal,
					}),
				);
			},
		},
	};
}

/**
 * The document tools for one Harness turn, closed over that turn's scoped
 * client and binding (`messages` is never read). `LoadDocuments` writes
 * through the session it is handed; the other two never touch it.
 */
export function createHarnessTools(
	deps: Parameters<typeof buildTools>[0],
): HarnessTurnTools {
	let workDir: string | undefined;
	return {
		tools: buildTools(deps, () => workDir),
		onSession: async ({ sessionWorkDir }) => {
			workDir = sessionWorkDir;
		},
	};
}
