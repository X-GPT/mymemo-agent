import path from "node:path/posix";
import { takeUtf8Bytes } from "../utf8";

export interface FileToolLimits {
	readMaxBytes: number;
	readMaxLines: number;
	grepMaxResults: number;
	globMaxResults: number;
	commandMaxOutputBytes: number;
	commandTimeoutMs: number;
}

export interface SandboxFileRead {
	path: string;
	maxBytes: number;
}

export interface SandboxFileWrite {
	path: string;
	content: string;
}

export interface SandboxFileCommand {
	command: string;
	cwd: string;
	timeoutMs: number;
	maxOutputBytes: number;
}

export interface SandboxFileCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

export interface SandboxFileClient {
	readFile(input: SandboxFileRead): Promise<string>;
	writeFile(input: SandboxFileWrite): Promise<void>;
	runCommand(input: SandboxFileCommand): Promise<SandboxFileCommandResult>;
}

export interface FileToolContext {
	client: SandboxFileClient;
	workspaceRoot: string;
	limits: FileToolLimits;
}

export interface ReadFileToolInput {
	path: string;
	offset?: number;
	limit?: number;
}

export interface WriteFileToolInput {
	path: string;
	content: string;
}

export interface EditFileToolInput {
	path: string;
	oldText: string;
	newText: string;
}

export interface GrepFileToolInput {
	pattern: string;
	path?: string;
	include?: string;
	caseSensitive?: boolean;
	maxResults?: number;
}

export interface GlobFileToolInput {
	pattern: string;
	path?: string;
	includeHidden?: boolean;
	maxResults?: number;
}

export interface FileToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

export interface WorkspacePath {
	absolutePath: string;
	relativePath: string;
}

export type WorkspacePathResult =
	| { ok: true; path: WorkspacePath }
	| { ok: false; error: string };

function toolText(payload: unknown): FileToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

function toolError(message: string): FileToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

export async function runReadFileTool(
	input: ReadFileToolInput,
	context: FileToolContext,
): Promise<FileToolResult> {
	const resolved = resolveWorkspacePath(input.path, context.workspaceRoot);
	if (!resolved.ok) return toolError(resolved.error);

	try {
		const rawContent = await context.client.readFile({
			path: resolved.path.absolutePath,
			maxBytes: context.limits.readMaxBytes + 1,
		});
		const byteWindow = takeUtf8Bytes(rawContent, context.limits.readMaxBytes);
		const startLine = normalizeStartLine(input.offset);
		const requestedLines = clampLineLimit(
			input.limit,
			context.limits.readMaxLines,
		);
		const lineWindow = takeLineWindow(
			byteWindow.text,
			startLine,
			requestedLines,
		);

		return toolText({
			path: resolved.path.relativePath,
			content: lineWindow.text,
			startLine,
			linesRead: countLines(lineWindow.text),
			truncated: byteWindow.truncated || lineWindow.truncated,
		});
	} catch (error) {
		return toolError(`Read failed: ${boundedErrorMessage(error)}`);
	}
}

export async function runWriteFileTool(
	input: WriteFileToolInput,
	context: FileToolContext,
): Promise<FileToolResult> {
	const resolved = resolveWorkspacePath(input.path, context.workspaceRoot);
	if (!resolved.ok) return toolError(resolved.error);

	try {
		await context.client.writeFile({
			path: resolved.path.absolutePath,
			content: input.content,
		});
		return toolText({
			path: resolved.path.relativePath,
			bytesWritten: Buffer.byteLength(input.content, "utf8"),
		});
	} catch (error) {
		return toolError(`Write failed: ${boundedErrorMessage(error)}`);
	}
}

export async function runEditFileTool(
	input: EditFileToolInput,
	context: FileToolContext,
): Promise<FileToolResult> {
	if (input.oldText === "") {
		return toolError("Edit requires non-empty oldText.");
	}
	const resolved = resolveWorkspacePath(input.path, context.workspaceRoot);
	if (!resolved.ok) return toolError(resolved.error);

	try {
		const rawContent = await context.client.readFile({
			path: resolved.path.absolutePath,
			maxBytes: context.limits.readMaxBytes + 1,
		});
		const byteWindow = takeUtf8Bytes(rawContent, context.limits.readMaxBytes);
		if (byteWindow.truncated) {
			return toolError("Edit failed: file exceeds edit size limit.");
		}
		const replacements = countOccurrences(byteWindow.text, input.oldText);
		if (replacements === 0) {
			return toolError("Edit failed: oldText was not found.");
		}

		await context.client.writeFile({
			path: resolved.path.absolutePath,
			content: byteWindow.text.split(input.oldText).join(input.newText),
		});
		return toolText({
			path: resolved.path.relativePath,
			replacements,
		});
	} catch (error) {
		return toolError(`Edit failed: ${boundedErrorMessage(error)}`);
	}
}

export async function runGrepFileTool(
	input: GrepFileToolInput,
	context: FileToolContext,
): Promise<FileToolResult> {
	if (!input.pattern) return toolError("Grep requires a non-empty pattern.");
	const resolved = resolveWorkspacePath(
		input.path ?? ".",
		context.workspaceRoot,
	);
	if (!resolved.ok) return toolError(resolved.error);
	if (input.include) {
		const includeError = validateWorkspacePattern(input.include, "include");
		if (includeError) return toolError(includeError);
	}

	const maxResults = clampResultLimit(
		input.maxResults,
		context.limits.grepMaxResults,
	);
	try {
		const commandResult = await context.client.runCommand({
			command: buildGrepCommand({
				pattern: input.pattern,
				path: resolved.path.relativePath,
				include: input.include,
				caseSensitive: input.caseSensitive ?? true,
				maxResults,
			}),
			cwd: path.normalize(context.workspaceRoot),
			timeoutMs: context.limits.commandTimeoutMs,
			maxOutputBytes: context.limits.commandMaxOutputBytes,
		});
		const commandError = commandFailure(commandResult);
		if (commandError) return toolError(`Grep failed: ${commandError}`);

		const parsed = parseRipgrepVimgrep(commandResult.stdout, maxResults);
		return toolText({
			matches: parsed.matches,
			truncated: parsed.truncated || commandResult.truncated,
		});
	} catch (error) {
		return toolError(`Grep failed: ${boundedErrorMessage(error)}`);
	}
}

export async function runGlobFileTool(
	input: GlobFileToolInput,
	context: FileToolContext,
): Promise<FileToolResult> {
	const patternError = validateWorkspacePattern(input.pattern, "Glob");
	if (patternError) return toolError(patternError);
	const resolved = resolveWorkspacePath(
		input.path ?? ".",
		context.workspaceRoot,
	);
	if (!resolved.ok) return toolError(resolved.error);

	const maxResults = clampResultLimit(
		input.maxResults,
		context.limits.globMaxResults,
	);
	try {
		const commandResult = await context.client.runCommand({
			command: buildGlobCommand({
				pattern: input.pattern,
				path: resolved.path.relativePath,
				includeHidden: input.includeHidden ?? false,
				maxResults,
			}),
			cwd: path.normalize(context.workspaceRoot),
			timeoutMs: context.limits.commandTimeoutMs,
			maxOutputBytes: context.limits.commandMaxOutputBytes,
		});
		const commandError = commandFailure(commandResult);
		if (commandError) return toolError(`Glob failed: ${commandError}`);

		const paths = commandResult.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map(normalizeCommandRelativePath)
			.filter((line): line is string => line !== undefined)
			.sort();
		const uniquePaths = [...new Set(paths)];
		return toolText({
			paths: uniquePaths.slice(0, maxResults),
			truncated: uniquePaths.length > maxResults || commandResult.truncated,
		});
	} catch (error) {
		return toolError(`Glob failed: ${boundedErrorMessage(error)}`);
	}
}

export function resolveWorkspacePath(
	inputPath: string | undefined,
	workspaceRoot: string,
): WorkspacePathResult {
	const rawPath = inputPath?.trim();
	if (!rawPath) return { ok: false, error: "path is required." };
	if (rawPath.includes("\0")) return { ok: false, error: "path is invalid." };
	if (hasTraversalSegment(rawPath)) {
		return { ok: false, error: "path must stay inside workspace." };
	}

	const root = path.normalize(workspaceRoot);
	if (!path.isAbsolute(root)) {
		return { ok: false, error: "workspace root must be absolute." };
	}

	const absolutePath = path.isAbsolute(rawPath)
		? path.normalize(rawPath)
		: path.normalize(path.join(root, rawPath));

	if (!isInsideWorkspace(absolutePath, root)) {
		return { ok: false, error: "path must stay inside workspace." };
	}

	const relativePath = path.relative(root, absolutePath) || ".";
	return { ok: true, path: { absolutePath, relativePath } };
}

function hasTraversalSegment(inputPath: string): boolean {
	return inputPath.split(/[\\/]+/).some((segment) => segment === "..");
}

function isInsideWorkspace(
	absolutePath: string,
	workspaceRoot: string,
): boolean {
	return (
		absolutePath === workspaceRoot ||
		absolutePath.startsWith(`${workspaceRoot}/`)
	);
}

function normalizeStartLine(offset: number | undefined): number {
	if (offset === undefined) return 1;
	return Math.max(1, Math.floor(offset));
}

function clampLineLimit(
	requested: number | undefined,
	configuredMax: number,
): number {
	if (requested === undefined) return configuredMax;
	return Math.min(configuredMax, Math.max(1, Math.floor(requested)));
}

function takeLineWindow(
	text: string,
	startLine: number,
	limit: number,
): { text: string; truncated: boolean } {
	if (!text) return { text: "", truncated: false };
	const lines = text.split("\n");
	const startIndex = startLine - 1;
	const selected = lines.slice(startIndex, startIndex + limit);
	return {
		text: selected.join("\n"),
		truncated: startIndex > 0 || lines.length > startIndex + limit,
	};
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function clampResultLimit(
	requested: number | undefined,
	configuredMax: number,
): number {
	if (requested === undefined) return configuredMax;
	return Math.min(configuredMax, Math.max(1, Math.floor(requested)));
}

function buildGrepCommand(input: {
	pattern: string;
	path: string;
	include: string | undefined;
	caseSensitive: boolean;
	maxResults: number;
}): string {
	const args = [
		"rg",
		"--vimgrep",
		"--field-match-separator",
		"\t",
		"--color",
		"never",
		"--sort",
		"path",
		"--line-number",
		"--column",
	];
	if (!input.caseSensitive) args.push("--ignore-case");
	if (input.include) args.push("--glob", input.include);
	args.push("--", input.pattern, input.path);
	return `${args.map(shellQuote).join(" ")} | head -n ${input.maxResults + 1}`;
}

function buildGlobCommand(input: {
	pattern: string;
	path: string;
	includeHidden: boolean;
	maxResults: number;
}): string {
	const args = ["rg", "--files", "--no-ignore", "--sort", "path"];
	args.push("--glob", path.join("/", input.path, input.pattern));
	if (input.includeHidden) {
		args.push("--hidden");
	} else {
		args.push("--glob", "!.*", "--glob", "!**/.*");
	}
	args.push("--", input.path);
	return `${args.map(shellQuote).join(" ")} | head -n ${input.maxResults + 1}`;
}

function parseRipgrepVimgrep(
	stdout: string,
	maxResults: number,
): {
	matches: { path: string; line: number; column: number; text: string }[];
	truncated: boolean;
} {
	const matches: {
		path: string;
		line: number;
		column: number;
		text: string;
	}[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const [rawPath, rawLine, rawColumn, ...rawText] = line.split("\t");
		if (!rawPath || !rawLine || !rawColumn) continue;
		const normalizedPath = normalizeCommandRelativePath(rawPath);
		if (!normalizedPath) continue;
		const lineNumber = Number(rawLine);
		const column = Number(rawColumn);
		if (!Number.isFinite(lineNumber) || !Number.isFinite(column)) continue;
		matches.push({
			path: normalizedPath,
			line: lineNumber,
			column,
			text: rawText.join("\t"),
		});
	}
	matches.sort((a, b) => {
		const pathOrder = a.path.localeCompare(b.path);
		if (pathOrder !== 0) return pathOrder;
		if (a.line !== b.line) return a.line - b.line;
		return a.column - b.column;
	});
	return {
		matches: matches.slice(0, maxResults),
		truncated: matches.length > maxResults,
	};
}

function normalizeCommandRelativePath(rawPath: string): string | undefined {
	const normalized = path.normalize(rawPath);
	if (
		path.isAbsolute(normalized) ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return undefined;
	}
	return normalized;
}

function validateWorkspacePattern(
	pattern: string,
	label: string,
): string | undefined {
	if (!pattern.trim()) return `${label} requires a non-empty pattern.`;
	if (pattern.includes("\0")) return `${label} pattern is invalid.`;
	if (path.isAbsolute(pattern) || hasTraversalSegment(pattern)) {
		return `${label} pattern must stay inside workspace.`;
	}
}

function commandFailure(result: SandboxFileCommandResult): string | undefined {
	const stderr = result.stderr.trim();
	if (stderr) return boundedErrorMessage(stderr);
	if (result.exitCode !== 0 && result.exitCode !== 1) {
		return `command exited with status ${result.exitCode}`;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function boundedErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}
