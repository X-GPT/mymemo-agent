import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	type SdkMcpToolDefinition,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
	type BashToolLimits,
	type CommandAuditEvent,
	runBashTool,
	type SandboxCommandClient,
} from "../bash-tool/bash-tool";
import {
	type FileToolLimits,
	runEditFileTool,
	runGrepFileTool,
	runReadFileTool,
	runWriteFileTool,
	type SandboxFileClient,
} from "../file-tools/file-tools";
import type { RunBinding } from "../sandbox-env";

type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

export function toCallToolResult(result: {
	content: { type: "text"; text: string }[];
	isError?: true;
}): CallToolResult {
	return result.isError
		? { content: result.content, isError: true }
		: { content: result.content };
}

export const EXECUTOR_SERVER_NAME = "mymemo-executor";
export const WORKSPACE_EXECUTOR_TOOL_NAMES = [
	"Read",
	"Write",
	"Edit",
	"Grep",
	"Bash",
] as const;
export const WORKSPACE_ALLOWED_TOOLS = WORKSPACE_EXECUTOR_TOOL_NAMES.map(
	(name) => `mcp__${EXECUTOR_SERVER_NAME}__${name}`,
);

export interface WorkspaceToolDeps {
	binding: RunBinding;
	workspaceRoot: string;
	signal: AbortSignal;
	fileClient: SandboxFileClient;
	commandClient: SandboxCommandClient;
	fileLimits: FileToolLimits;
	bashLimits: BashToolLimits;
	markSandboxTainted(reason: string): Promise<void>;
	recordCommandAudit(event: CommandAuditEvent): Promise<void>;
}

export function buildWorkspaceTools(deps: WorkspaceToolDeps) {
	const fileContext = {
		client: deps.fileClient,
		workspaceRoot: deps.workspaceRoot,
		limits: deps.fileLimits,
	};
	return [
		tool(
			"Read",
			"Read a UTF-8 text file from the Workspace, with optional line offset/limit.",
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
			"Create or overwrite a file in the Workspace with the given content.",
			{ path: z.string(), content: z.string() },
			async (input) =>
				toCallToolResult(await runWriteFileTool(input, fileContext)),
		),
		tool(
			"Edit",
			"Replace every occurrence of oldText with newText in a Workspace file.",
			{ path: z.string(), oldText: z.string(), newText: z.string() },
			async (input) =>
				toCallToolResult(await runEditFileTool(input, fileContext)),
		),
		tool(
			"Grep",
			"Search file contents in the Workspace for a pattern.",
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
			"Bash",
			"Run a foreground shell command in the Workspace and return its output.",
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
	];
}

export function createWorkspaceMcpServer(
	deps: WorkspaceToolDeps,
): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: EXECUTOR_SERVER_NAME,
		tools: buildWorkspaceTools(deps),
		alwaysLoad: true,
	});
}
