import type {
	PublicToolName,
	ToolResultPayload,
	ToolUsePayload,
} from "@mymemo/agent-db/run-events";
import { EXECUTOR_SERVER_NAME } from "./run-tools";

/**
 * The explicit per-tool client projection (ADR-0009). This pure module is the
 * only place SDK tool input or executor output becomes a client-visible payload
 * — never a pass-through: every field is read defensively, re-projected
 * bounded, and the whole event is capped at {@link TOOL_EVENT_MAX_JSON_BYTES}
 * of serialized JSON. A projection that cannot be produced safely returns
 * `ok: false` with a reason for the caller to log; the tool event is omitted
 * and the run continues (fail closed — a surprising shape degrades visibility,
 * not correctness).
 *
 * Bash (the ADR-0009 tracer bullet) and the five file tools — Read, Write,
 * Edit, Grep, Glob — have projections; the two document tools are allowlisted
 * names whose events are omitted until their projections land.
 */

/** Hard cap on one tool event: 16 KiB of UTF-8 JSON after projection. An event
 * is never split across frames; what cannot fit capped is omitted. */
export const TOOL_EVENT_MAX_JSON_BYTES = 16_384;

/** Serialized-JSON budgets per preview field, chosen so a fully populated
 * event for any projected tool stays well under the event cap by construction. */
const COMMAND_PREVIEW_MAX_JSON_BYTES = 2_048;
const CWD_PREVIEW_MAX_JSON_BYTES = 512;
const OUTPUT_PREVIEW_MAX_JSON_BYTES = 6_144;
const OUTCOME_MAX_JSON_BYTES = 64;
const PATH_PREVIEW_MAX_JSON_BYTES = 512;
const READ_CONTENT_PREVIEW_MAX_JSON_BYTES = 6_144;
const TEXT_PREVIEW_MAX_JSON_BYTES = 2_048;
const PATTERN_PREVIEW_MAX_JSON_BYTES = 1_024;

/** List budgets: count bounds and per-item previews sized so the largest list
 * event stays comfortably under the cap (Grep worst case ≈ 12 KiB). */
const GREP_RESULT_MAX_MATCHES = 20;
const GLOB_RESULT_MAX_PATHS = 40;
const LIST_PATH_PREVIEW_MAX_JSON_BYTES = 256;
const MATCH_TEXT_PREVIEW_MAX_JSON_BYTES = 256;

/** The fixed error result (ADR-0009): the tool boundary flattens validation and
 * infrastructure failures into one text shape, so no raw error text is ever
 * classified or forwarded. */
const TOOL_FAILED_RESULT = { message: "Tool failed" } as const;

/**
 * The allowlist from the executor server's prefixed tool names to the eight
 * short public names. Only names in this map may ever reach the client stream;
 * unknown, built-in, or permission-denied tool names map to `null` and their
 * events are omitted. A drift pin ties this map's domain to the executor tools
 * the worker actually builds.
 */
const PUBLIC_TOOL_NAMES_BY_EXECUTOR_NAME: Readonly<
	Record<string, PublicToolName>
> = {
	[`mcp__${EXECUTOR_SERVER_NAME}__Read`]: "Read",
	[`mcp__${EXECUTOR_SERVER_NAME}__Write`]: "Write",
	[`mcp__${EXECUTOR_SERVER_NAME}__Edit`]: "Edit",
	[`mcp__${EXECUTOR_SERVER_NAME}__Grep`]: "Grep",
	[`mcp__${EXECUTOR_SERVER_NAME}__Glob`]: "Glob",
	[`mcp__${EXECUTOR_SERVER_NAME}__Bash`]: "Bash",
	[`mcp__${EXECUTOR_SERVER_NAME}__SearchDocuments`]: "SearchDocuments",
	[`mcp__${EXECUTOR_SERVER_NAME}__LoadDocuments`]: "LoadDocuments",
};

/** The allowlist's domain, for the drift pin against the built executor tools. */
export function allowlistedExecutorToolNames(): string[] {
	return Object.keys(PUBLIC_TOOL_NAMES_BY_EXECUTOR_NAME);
}

/** Map an SDK tool-use block's name to its public name, or `null` when the
 * name is not an allowlisted executor tool (log and omit upstream). */
export function publicToolName(toolName: unknown): PublicToolName | null {
	if (typeof toolName !== "string") return null;
	return PUBLIC_TOOL_NAMES_BY_EXECUTOR_NAME[toolName] ?? null;
}

/** One projected tool event, or the log-worthy reason it must be omitted. */
export type ToolEventProjection<Payload> =
	| { ok: true; payload: Payload }
	| { ok: false; reason: string };

/**
 * Project one Tool invocation's model-authored input into the durable
 * client-safe `tool_use` payload.
 */
export function projectToolUse(
	tool: PublicToolName,
	input: unknown,
): ToolEventProjection<ToolUsePayload> {
	const projected = projectToolUseArguments(tool, isRecord(input) ? input : {});
	if (projected === null) {
		return { ok: false, reason: `no argument projection for tool ${tool}` };
	}
	return fitOrOmit({
		tool,
		arguments: projected.args,
		truncated: projected.clipped,
	});
}

/** Bounded per-tool arguments plus whether any field was clipped to fit. */
interface ProjectedArguments {
	args: Record<string, unknown>;
	clipped: boolean;
}

/** Dispatch to the per-tool argument projection; `null` for tools without one
 * yet, whose invocations are logged and omitted upstream. */
function projectToolUseArguments(
	tool: PublicToolName,
	fields: Record<string, unknown>,
): ProjectedArguments | null {
	switch (tool) {
		case "Read":
			return readToolUseArguments(fields);
		case "Write":
			return writeToolUseArguments(fields);
		case "Edit":
			return editToolUseArguments(fields);
		case "Grep":
			return grepToolUseArguments(fields);
		case "Glob":
			return globToolUseArguments(fields);
		case "Bash":
			return bashToolUseArguments(fields);
		default:
			return null;
	}
}

function bashToolUseArguments(
	fields: Record<string, unknown>,
): ProjectedArguments {
	const args: Record<string, unknown> = {};
	let clipped = putClampedString(
		args,
		"command",
		fields.command,
		COMMAND_PREVIEW_MAX_JSON_BYTES,
	);
	clipped =
		putClampedString(args, "cwd", fields.cwd, CWD_PREVIEW_MAX_JSON_BYTES) ||
		clipped;
	putFiniteNumber(args, "timeoutMs", fields.timeoutMs);
	return { args, clipped };
}

function readToolUseArguments(
	fields: Record<string, unknown>,
): ProjectedArguments {
	const args: Record<string, unknown> = {};
	const clipped = putClampedString(
		args,
		"path",
		fields.path,
		PATH_PREVIEW_MAX_JSON_BYTES,
	);
	putFiniteNumber(args, "offset", fields.offset);
	putFiniteNumber(args, "limit", fields.limit);
	return { args, clipped };
}

function writeToolUseArguments(
	fields: Record<string, unknown>,
): ProjectedArguments {
	const args: Record<string, unknown> = {};
	let clipped = putClampedString(
		args,
		"path",
		fields.path,
		PATH_PREVIEW_MAX_JSON_BYTES,
	);
	clipped = putTextPreviewWithBytes(args, "content", fields.content) || clipped;
	return { args, clipped };
}

function editToolUseArguments(
	fields: Record<string, unknown>,
): ProjectedArguments {
	const args: Record<string, unknown> = {};
	let clipped = putClampedString(
		args,
		"path",
		fields.path,
		PATH_PREVIEW_MAX_JSON_BYTES,
	);
	clipped = putTextPreviewWithBytes(args, "oldText", fields.oldText) || clipped;
	clipped = putTextPreviewWithBytes(args, "newText", fields.newText) || clipped;
	return { args, clipped };
}

function grepToolUseArguments(
	fields: Record<string, unknown>,
): ProjectedArguments {
	const args: Record<string, unknown> = {};
	let clipped = putClampedString(
		args,
		"pattern",
		fields.pattern,
		PATTERN_PREVIEW_MAX_JSON_BYTES,
	);
	clipped =
		putClampedString(args, "path", fields.path, PATH_PREVIEW_MAX_JSON_BYTES) ||
		clipped;
	clipped =
		putClampedString(
			args,
			"include",
			fields.include,
			PATTERN_PREVIEW_MAX_JSON_BYTES,
		) || clipped;
	putBoolean(args, "caseSensitive", fields.caseSensitive);
	putFiniteNumber(args, "maxResults", fields.maxResults);
	return { args, clipped };
}

function globToolUseArguments(
	fields: Record<string, unknown>,
): ProjectedArguments {
	const args: Record<string, unknown> = {};
	let clipped = putClampedString(
		args,
		"pattern",
		fields.pattern,
		PATTERN_PREVIEW_MAX_JSON_BYTES,
	);
	clipped =
		putClampedString(args, "path", fields.path, PATH_PREVIEW_MAX_JSON_BYTES) ||
		clipped;
	putBoolean(args, "includeHidden", fields.includeHidden);
	putFiniteNumber(args, "maxResults", fields.maxResults);
	return { args, clipped };
}

/** Set `args[key]` to a bounded text preview and `args[<key>Bytes]` to the
 * full UTF-8 byte count when `value` is a string — the count reports the true
 * size even when the preview is clipped. Returns whether it was clipped. */
function putTextPreviewWithBytes(
	args: Record<string, unknown>,
	key: string,
	value: unknown,
): boolean {
	if (typeof value !== "string") return false;
	const clamped = clampJsonString(value, TEXT_PREVIEW_MAX_JSON_BYTES);
	args[key] = clamped.text;
	args[`${key}Bytes`] = Buffer.byteLength(value, "utf8");
	return clamped.clipped;
}

/** Set `args[key]` to a bounded preview when `value` is a string — anything
 * else is omitted, never coerced. Returns whether the preview was clipped. */
function putClampedString(
	args: Record<string, unknown>,
	key: string,
	value: unknown,
	maxJsonBytes: number,
): boolean {
	if (typeof value !== "string") return false;
	const clamped = clampJsonString(value, maxJsonBytes);
	args[key] = clamped.text;
	return clamped.clipped;
}

/** Set `args[key]` when `value` is a finite number; anything else is omitted. */
function putFiniteNumber(
	args: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (typeof value === "number" && Number.isFinite(value)) {
		args[key] = value;
	}
}

/** Set `args[key]` when `value` is a boolean; anything else is omitted. */
function putBoolean(
	args: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (typeof value === "boolean") {
		args[key] = value;
	}
}

/**
 * Project one Tool result's MCP content into the durable client-safe
 * `tool_result` payload. An error-flagged result never parses its content —
 * it always projects the fixed safe message.
 */
export function projectToolResult(
	tool: PublicToolName,
	content: unknown,
	isError: boolean,
): ToolEventProjection<ToolResultPayload> {
	if (isError) {
		return {
			ok: true,
			payload: {
				tool,
				result: { ...TOOL_FAILED_RESULT },
				isError: true,
				truncated: false,
			},
		};
	}
	switch (tool) {
		case "Read":
			return projectReadResult(content);
		case "Write":
			return projectWriteResult(content);
		case "Edit":
			return projectEditResult(content);
		case "Grep":
			return projectGrepResult(content);
		case "Glob":
			return projectGlobResult(content);
		case "Bash":
			return projectBashResult(content);
		default:
			return { ok: false, reason: `no result projection for tool ${tool}` };
	}
}

function projectWriteResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseWriteResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "Write result did not match the executor shape",
		};
	}
	const path = clampJsonString(raw.path, PATH_PREVIEW_MAX_JSON_BYTES);
	return fitOrOmit({
		tool: "Write",
		result: { path: path.text, bytesWritten: raw.bytesWritten },
		isError: false,
		truncated: path.clipped,
	});
}

function projectEditResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseEditResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "Edit result did not match the executor shape",
		};
	}
	const path = clampJsonString(raw.path, PATH_PREVIEW_MAX_JSON_BYTES);
	return fitOrOmit({
		tool: "Edit",
		result: { path: path.text, replacements: raw.replacements },
		isError: false,
		truncated: path.clipped,
	});
}

function projectGrepResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseGrepResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "Grep result did not match the executor shape",
		};
	}
	const listClipped = raw.matches.length > GREP_RESULT_MAX_MATCHES;
	let itemClipped = false;
	const matches = raw.matches.slice(0, GREP_RESULT_MAX_MATCHES).map((match) => {
		const path = clampJsonString(match.path, LIST_PATH_PREVIEW_MAX_JSON_BYTES);
		const text = clampJsonString(match.text, MATCH_TEXT_PREVIEW_MAX_JSON_BYTES);
		itemClipped ||= path.clipped || text.clipped;
		return {
			path: path.text,
			line: match.line,
			column: match.column,
			text: text.text,
		};
	});
	return fitOrOmit({
		tool: "Grep",
		result: {
			matches,
			// A list clipped by projection is no longer the complete match list,
			// exactly as when the executor's own result cap truncated it.
			truncated: raw.truncated || listClipped,
		},
		isError: false,
		truncated: listClipped || itemClipped,
	});
}

function projectGlobResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseGlobResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "Glob result did not match the executor shape",
		};
	}
	const listClipped = raw.paths.length > GLOB_RESULT_MAX_PATHS;
	let itemClipped = false;
	const paths = raw.paths.slice(0, GLOB_RESULT_MAX_PATHS).map((rawPath) => {
		const path = clampJsonString(rawPath, LIST_PATH_PREVIEW_MAX_JSON_BYTES);
		itemClipped ||= path.clipped;
		return path.text;
	});
	return fitOrOmit({
		tool: "Glob",
		result: {
			paths,
			// A list clipped by projection is no longer the complete path list,
			// exactly as when the executor's own result cap truncated it.
			truncated: raw.truncated || listClipped,
		},
		isError: false,
		truncated: listClipped || itemClipped,
	});
}

function projectBashResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseBashResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "Bash result did not match the executor shape",
		};
	}
	const stdout = clampJsonString(raw.stdout, OUTPUT_PREVIEW_MAX_JSON_BYTES);
	const stderr = clampJsonString(raw.stderr, OUTPUT_PREVIEW_MAX_JSON_BYTES);
	const outcome = clampJsonString(raw.outcome, OUTCOME_MAX_JSON_BYTES);
	const clipped = stdout.clipped || stderr.clipped || outcome.clipped;
	return fitOrOmit({
		tool: "Bash",
		result: {
			exitCode: raw.exitCode,
			stdout: stdout.text,
			stderr: stderr.text,
			// A preview clipped by projection is no longer the complete stream,
			// exactly as when the executor's own byte cap truncated it.
			stdoutTruncated: raw.stdoutTruncated || stdout.clipped,
			stderrTruncated: raw.stderrTruncated || stderr.clipped,
			outcome: outcome.text,
		},
		isError: false,
		truncated: clipped,
	});
}

function projectReadResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseReadResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "Read result did not match the executor shape",
		};
	}
	const path = clampJsonString(raw.path, PATH_PREVIEW_MAX_JSON_BYTES);
	const preview = clampJsonString(
		raw.content,
		READ_CONTENT_PREVIEW_MAX_JSON_BYTES,
	);
	const clipped = path.clipped || preview.clipped;
	return fitOrOmit({
		tool: "Read",
		result: {
			path: path.text,
			content: preview.text,
			startLine: raw.startLine,
			linesRead: raw.linesRead,
			// A preview clipped by projection is no longer the full read window,
			// exactly as when the executor's own caps truncated it.
			truncated: raw.truncated || preview.clipped,
		},
		isError: false,
		truncated: clipped,
	});
}

/** The executor Bash tool's structured success result (see `runBashTool`). */
interface RawBashResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	outcome: string;
}

/** Parse the worker-owned executor JSON out of the MCP result content,
 * field by field; `null` on any shape surprise (omit upstream). */
function parseBashResult(content: unknown): RawBashResult | null {
	const parsed = parseExecutorResult(content);
	if (parsed === null) return null;
	const exitCode = parsed.exitCode;
	if (exitCode !== null && !isFiniteNumber(exitCode)) {
		return null;
	}
	if (typeof parsed.stdout !== "string" || typeof parsed.stderr !== "string") {
		return null;
	}
	if (
		typeof parsed.stdoutTruncated !== "boolean" ||
		typeof parsed.stderrTruncated !== "boolean" ||
		typeof parsed.outcome !== "string"
	) {
		return null;
	}
	return {
		exitCode,
		stdout: parsed.stdout,
		stderr: parsed.stderr,
		stdoutTruncated: parsed.stdoutTruncated,
		stderrTruncated: parsed.stderrTruncated,
		outcome: parsed.outcome,
	};
}

/** The executor Read tool's structured success result (see `runReadFileTool`). */
interface RawReadResult {
	path: string;
	content: string;
	startLine: number;
	linesRead: number;
	truncated: boolean;
}

function parseReadResult(content: unknown): RawReadResult | null {
	const parsed = parseExecutorResult(content);
	if (parsed === null) return null;
	if (typeof parsed.path !== "string" || typeof parsed.content !== "string") {
		return null;
	}
	if (!isFiniteNumber(parsed.startLine) || !isFiniteNumber(parsed.linesRead)) {
		return null;
	}
	if (typeof parsed.truncated !== "boolean") return null;
	return {
		path: parsed.path,
		content: parsed.content,
		startLine: parsed.startLine,
		linesRead: parsed.linesRead,
		truncated: parsed.truncated,
	};
}

/** The executor Write tool's structured success result (see `runWriteFileTool`). */
interface RawWriteResult {
	path: string;
	bytesWritten: number;
}

function parseWriteResult(content: unknown): RawWriteResult | null {
	const parsed = parseExecutorResult(content);
	if (parsed === null) return null;
	if (typeof parsed.path !== "string" || !isFiniteNumber(parsed.bytesWritten)) {
		return null;
	}
	return { path: parsed.path, bytesWritten: parsed.bytesWritten };
}

/** The executor Edit tool's structured success result (see `runEditFileTool`). */
interface RawEditResult {
	path: string;
	replacements: number;
}

function parseEditResult(content: unknown): RawEditResult | null {
	const parsed = parseExecutorResult(content);
	if (parsed === null) return null;
	if (typeof parsed.path !== "string" || !isFiniteNumber(parsed.replacements)) {
		return null;
	}
	return { path: parsed.path, replacements: parsed.replacements };
}

/** One match of the executor Grep tool's structured success result. */
interface RawGrepMatch {
	path: string;
	line: number;
	column: number;
	text: string;
}

/** The executor Grep tool's structured success result (see `runGrepFileTool`). */
interface RawGrepResult {
	matches: RawGrepMatch[];
	truncated: boolean;
}

function parseGrepResult(content: unknown): RawGrepResult | null {
	const parsed = parseExecutorResult(content);
	if (parsed === null) return null;
	if (!Array.isArray(parsed.matches) || typeof parsed.truncated !== "boolean") {
		return null;
	}
	const matches: RawGrepMatch[] = [];
	for (const match of parsed.matches) {
		if (
			!isRecord(match) ||
			typeof match.path !== "string" ||
			!isFiniteNumber(match.line) ||
			!isFiniteNumber(match.column) ||
			typeof match.text !== "string"
		) {
			return null;
		}
		matches.push({
			path: match.path,
			line: match.line,
			column: match.column,
			text: match.text,
		});
	}
	return { matches, truncated: parsed.truncated };
}

/** The executor Glob tool's structured success result (see `runGlobFileTool`). */
interface RawGlobResult {
	paths: string[];
	truncated: boolean;
}

function parseGlobResult(content: unknown): RawGlobResult | null {
	const parsed = parseExecutorResult(content);
	if (parsed === null) return null;
	if (!Array.isArray(parsed.paths) || typeof parsed.truncated !== "boolean") {
		return null;
	}
	const paths: string[] = [];
	for (const path of parsed.paths) {
		if (typeof path !== "string") return null;
		paths.push(path);
	}
	return { paths, truncated: parsed.truncated };
}

/** Extract and parse the executor's structured JSON success text out of the
 * MCP result content; `null` on any surprise (omit upstream). */
function parseExecutorResult(content: unknown): Record<string, unknown> | null {
	const text = resultText(content);
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	return isRecord(parsed) ? parsed : null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Extract the executor's text from MCP tool-result content: a plain string or
 * text blocks (the executor emits exactly one); `null` when there is none. */
function resultText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	let text = "";
	for (const item of content) {
		if (
			isRecord(item) &&
			item.type === "text" &&
			typeof item.text === "string"
		) {
			text += item.text;
		}
	}
	return text.length > 0 ? text : null;
}

/** The final cap: a payload whose serialized form still exceeds the event cap
 * is omitted rather than split or appended oversize. Per-field budgets make
 * this unreachable for every projected tool; it guards future projections and
 * shape drift.
 * Exported only for the size-cap conformance test — production code reaches it
 * through the per-tool projections. */
export function fitOrOmit<Payload extends Record<string, unknown>>(
	payload: Payload,
): ToolEventProjection<Payload> {
	if (
		Buffer.byteLength(JSON.stringify(payload), "utf8") >
		TOOL_EVENT_MAX_JSON_BYTES
	) {
		return {
			ok: false,
			reason: "tool event exceeds the size cap after projection",
		};
	}
	return { ok: true, payload };
}

/**
 * Clip `text` so its JSON string serialization fits `maxJsonBytes` of UTF-8
 * (quotes excluded, escapes included) — the budget bounds what the event
 * actually costs on the wire, not the raw character count.
 */
function clampJsonString(
	text: string,
	maxJsonBytes: number,
): { text: string; clipped: boolean } {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const cost = jsonStringByteCost(char);
		if (bytes + cost > maxJsonBytes) {
			return { text: text.slice(0, end), clipped: true };
		}
		bytes += cost;
		end += char.length;
	}
	return { text, clipped: false };
}

/** UTF-8 bytes one code point contributes inside a JSON string literal. */
function jsonStringByteCost(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code === 0x22 || code === 0x5c) return 2; // \" and \\
	if (code < 0x20) {
		// \b \t \n \f \r are two-byte escapes; other controls escape as \u00XX.
		return code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
			? 2
			: 6;
	}
	if (code >= 0xd800 && code <= 0xdfff) return 6; // lone surrogate → \uXXXX
	if (code < 0x80) return 1;
	if (code < 0x800) return 2;
	if (code < 0x10000) return 3;
	return 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
