import { z } from "zod";
import type {
	PublicToolName,
	ToolResultPayload,
	ToolUsePayload,
} from "./run-events";

const EXECUTOR_SERVER_NAME = "mymemo-executor";
const PRESENT_UI_TOOL_NAME = "PresentUI";

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
 * All eight projected executor tools have bounded client projections.
 */

/** Hard cap on one tool event: 16 KiB of UTF-8 JSON after projection. An event
 * is never split across frames; what cannot fit capped is omitted. */
export const TOOL_EVENT_MAX_JSON_BYTES = 16_384;

/** Serialized-JSON budgets per preview field, chosen so a fully populated
 * event for any projected tool stays well under the event cap by construction. */
const COMMAND_PREVIEW_MAX_JSON_BYTES = 2_048;
const QUERY_PREVIEW_MAX_JSON_BYTES = 2_048;
const CWD_PREVIEW_MAX_JSON_BYTES = 512;
const OUTPUT_PREVIEW_MAX_JSON_BYTES = 6_144;
const OUTCOME_MAX_JSON_BYTES = 64;
const PATH_PREVIEW_MAX_JSON_BYTES = 512;
const READ_CONTENT_PREVIEW_MAX_JSON_BYTES = 6_144;
const TEXT_PREVIEW_MAX_JSON_BYTES = 2_048;
const PATTERN_PREVIEW_MAX_JSON_BYTES = 1_024;
const DOCUMENT_TITLE_PREVIEW_MAX_JSON_BYTES = 512;
const DOCUMENT_SNIPPET_PREVIEW_MAX_JSON_BYTES = 2_048;

/** List budgets: count bounds and per-item previews sized so the largest list
 * event stays comfortably under the cap (Grep worst case ≈ 12 KiB). */
const GREP_RESULT_MAX_MATCHES = 20;
const LIST_PATH_PREVIEW_MAX_JSON_BYTES = 256;
const MATCH_TEXT_PREVIEW_MAX_JSON_BYTES = 256;
const SEARCH_PASSAGE_PREVIEW_MAX_ITEMS = 5;
const LIST_DOCUMENT_TITLE_PREVIEW_MAX_ITEMS = 10;
const LOAD_TITLE_PREVIEW_MAX_ITEMS = 10;
const LOAD_FAILURE_SUMMARY = "Some documents could not be loaded";

/** The fixed error result (ADR-0009): the tool boundary flattens validation and
 * infrastructure failures into one text shape, so no raw error text is ever
 * classified or forwarded. */
const TOOL_FAILED_RESULT = { message: "Tool failed" } as const;

/**
 * The allowlist from the executor server's prefixed tool names to the eight
 * short public names. Only names in this map may ever reach the client stream;
 * unknown, built-in, or permission-denied tool names map to `null` and their
 * events are omitted. A drift pin ties this map's domain to the executor tools
 * the Runtime actually builds.
 */
const PUBLIC_TOOL_NAMES_BY_EXECUTOR_NAME: ReadonlyMap<string, PublicToolName> =
	new Map<string, PublicToolName>([
		[`mcp__${EXECUTOR_SERVER_NAME}__Read`, "Read"],
		[`mcp__${EXECUTOR_SERVER_NAME}__Write`, "Write"],
		[`mcp__${EXECUTOR_SERVER_NAME}__Edit`, "Edit"],
		[`mcp__${EXECUTOR_SERVER_NAME}__Grep`, "Grep"],
		[`mcp__${EXECUTOR_SERVER_NAME}__Bash`, "Bash"],
		[`mcp__${EXECUTOR_SERVER_NAME}__ListDocuments`, "ListDocuments"],
		[`mcp__${EXECUTOR_SERVER_NAME}__SearchDocuments`, "SearchDocuments"],
		[`mcp__${EXECUTOR_SERVER_NAME}__LoadDocuments`, "LoadDocuments"],
	]);

/** The allowlist's domain, for the drift pin against the built executor tools. */
export function allowlistedExecutorToolNames(): string[] {
	return [...PUBLIC_TOOL_NAMES_BY_EXECUTOR_NAME.keys()];
}

/** Map an SDK tool-use block's name to its public name, or `null` when the
 * name is not an allowlisted executor tool (log and omit upstream). */
export function publicToolName(toolName: unknown): PublicToolName | null {
	if (typeof toolName !== "string") return null;
	return PUBLIC_TOOL_NAMES_BY_EXECUTOR_NAME.get(toolName) ?? null;
}

/** PresentUI is deliberately classified outside ADR-0009 Tool projection: its
 * validated payload is Assistant content and its invocation/result stay hidden. */
export function isPresentUiToolName(toolName: unknown): boolean {
	return toolName === `mcp__${EXECUTOR_SERVER_NAME}__${PRESENT_UI_TOOL_NAME}`;
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
	if (tool === "SearchDocuments") {
		return projectSearchDocumentsUse(input);
	}
	if (tool === "ListDocuments") {
		return projectListDocumentsUse(input);
	}
	if (tool === "LoadDocuments") {
		return projectLoadDocumentsUse(input);
	}
	if (!isRecord(input)) {
		return {
			ok: false,
			reason: `${tool} arguments did not match the executor shape`,
		};
	}
	const projected = projectToolUseArguments(tool, input);
	if (projected === null) {
		return {
			ok: false,
			reason: `${tool} arguments did not match the executor shape`,
		};
	}
	return fitOrOmit({
		tool,
		arguments: projected.args,
		truncated: projected.clipped,
	});
}

function projectSearchDocumentsUse(
	input: unknown,
): ToolEventProjection<ToolUsePayload> {
	if (!isRecord(input) || typeof input.query !== "string") {
		return {
			ok: false,
			reason: "SearchDocuments arguments did not match the executor shape",
		};
	}
	const query = clampJsonString(input.query, QUERY_PREVIEW_MAX_JSON_BYTES);
	return fitOrOmit({
		tool: "SearchDocuments",
		arguments: { query: query.text },
		truncated: query.clipped,
	});
}

function projectListDocumentsUse(
	input: unknown,
): ToolEventProjection<ToolUsePayload> {
	if (
		!isRecord(input) ||
		(input.limit !== undefined && !isFiniteNumber(input.limit)) ||
		(input.cursor !== undefined && typeof input.cursor !== "string")
	) {
		return {
			ok: false,
			reason: "ListDocuments arguments did not match the executor shape",
		};
	}
	return fitOrOmit({
		tool: "ListDocuments",
		arguments: {
			...(input.limit === undefined ? {} : { limit: input.limit }),
			cursorProvided: typeof input.cursor === "string",
		},
		truncated: false,
	});
}

function projectLoadDocumentsUse(
	input: unknown,
): ToolEventProjection<ToolUsePayload> {
	if (
		!isRecord(input) ||
		!Array.isArray(input.documentIds) ||
		!input.documentIds.every((documentId) => typeof documentId === "string")
	) {
		return {
			ok: false,
			reason: "LoadDocuments arguments did not match the executor shape",
		};
	}
	return fitOrOmit({
		tool: "LoadDocuments",
		arguments: { requestedCount: input.documentIds.length },
		truncated: false,
	});
}

/** Bounded per-tool arguments plus whether any field was clipped to fit. */
interface ProjectedArguments {
	args: Record<string, unknown>;
	clipped: boolean;
}

/** Dispatch to the per-tool argument projection; `null` when required
 * arguments do not match the executor schema. */
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
		case "Bash":
			return bashToolUseArguments(fields);
		default:
			return null;
	}
}

function bashToolUseArguments(
	fields: Record<string, unknown>,
): ProjectedArguments | null {
	if (typeof fields.command !== "string") return null;
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
): ProjectedArguments | null {
	if (typeof fields.path !== "string") return null;
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
): ProjectedArguments | null {
	if (typeof fields.path !== "string" || typeof fields.content !== "string") {
		return null;
	}
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
): ProjectedArguments | null {
	if (
		typeof fields.path !== "string" ||
		typeof fields.oldText !== "string" ||
		typeof fields.newText !== "string"
	) {
		return null;
	}
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
): ProjectedArguments | null {
	if (typeof fields.pattern !== "string") return null;
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
		case "Bash":
			return projectBashResult(content);
		case "ListDocuments":
			return projectListDocumentsResult(content);
		case "SearchDocuments":
			return projectSearchDocumentsResult(content);
		case "LoadDocuments":
			return projectLoadDocumentsResult(content);
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

function projectSearchDocumentsResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseSearchDocumentsResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "SearchDocuments result did not match the executor shape",
		};
	}
	let clipped = raw.length > SEARCH_PASSAGE_PREVIEW_MAX_ITEMS;
	const passages = raw
		.slice(0, SEARCH_PASSAGE_PREVIEW_MAX_ITEMS)
		.map((passage) => {
			const title = clampJsonString(
				passage.title,
				DOCUMENT_TITLE_PREVIEW_MAX_JSON_BYTES,
			);
			const snippet = clampJsonString(
				passage.snippet,
				DOCUMENT_SNIPPET_PREVIEW_MAX_JSON_BYTES,
			);
			clipped ||= title.clipped || snippet.clipped;
			return { title: title.text, snippet: snippet.text };
		});
	return fitOrOmit({
		tool: "SearchDocuments",
		result: { passages },
		isError: false,
		truncated: clipped,
	});
}

function projectListDocumentsResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseListDocumentsResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "ListDocuments result did not match the executor shape",
		};
	}
	let clipped = raw.titles.length > LIST_DOCUMENT_TITLE_PREVIEW_MAX_ITEMS;
	const documents = raw.titles
		.slice(0, LIST_DOCUMENT_TITLE_PREVIEW_MAX_ITEMS)
		.map((rawTitle) => {
			const title = clampJsonString(
				rawTitle,
				DOCUMENT_TITLE_PREVIEW_MAX_JSON_BYTES,
			);
			clipped ||= title.clipped;
			return { title: title.text };
		});
	return fitOrOmit({
		tool: "ListDocuments",
		result: {
			total: raw.total,
			returnedCount: raw.titles.length,
			hasMore: raw.hasMore,
			documents,
		},
		isError: false,
		truncated: clipped,
	});
}

function projectLoadDocumentsResult(
	content: unknown,
): ToolEventProjection<ToolResultPayload> {
	const raw = parseLoadDocumentsResult(content);
	if (raw === null) {
		return {
			ok: false,
			reason: "LoadDocuments result did not match the executor shape",
		};
	}
	let clipped = raw.loadedTitles.length > LOAD_TITLE_PREVIEW_MAX_ITEMS;
	const loaded = raw.loadedTitles
		.slice(0, LOAD_TITLE_PREVIEW_MAX_ITEMS)
		.map((rawTitle) => {
			const title = clampJsonString(
				rawTitle,
				DOCUMENT_TITLE_PREVIEW_MAX_JSON_BYTES,
			);
			clipped ||= title.clipped;
			return { title: title.text };
		});
	return fitOrOmit({
		tool: "LoadDocuments",
		result: {
			loadedCount: raw.loadedTitles.length,
			loaded,
			failedCount: raw.failedCount,
			...(raw.failedCount > 0 ? { failureSummary: LOAD_FAILURE_SUMMARY } : {}),
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

const finiteNumber = z.number().finite();

const listDocumentsResult = z
	.object({
		total: finiteNumber.int().nonnegative(),
		documents: z.array(z.object({ title: z.string() })),
		nextCursor: z.string().nullable(),
	})
	.transform(({ total, documents, nextCursor }) => ({
		total,
		titles: documents.map(({ title }) => title),
		hasMore: nextCursor !== null,
	}));

function parseListDocumentsResult(
	content: unknown,
): z.output<typeof listDocumentsResult> | null {
	return parseExecutorResult(content, listDocumentsResult);
}

const searchDocumentsResult = z
	.object({
		passages: z.array(z.object({ title: z.string(), snippet: z.string() })),
	})
	.transform(({ passages }) => passages);

function parseSearchDocumentsResult(
	content: unknown,
): z.output<typeof searchDocumentsResult> | null {
	return parseExecutorResult(content, searchDocumentsResult);
}

const loadDocumentsResult = z
	.object({
		loaded: z.array(z.object({ title: z.string() })),
		errors: z.array(z.object({ error: z.string() })),
	})
	.transform(({ loaded, errors }) => ({
		loadedTitles: loaded.map(({ title }) => title),
		failedCount: errors.length,
	}));

function parseLoadDocumentsResult(
	content: unknown,
): z.output<typeof loadDocumentsResult> | null {
	return parseExecutorResult(content, loadDocumentsResult);
}

const bashResult = z.object({
	exitCode: finiteNumber.nullable(),
	stdout: z.string(),
	stderr: z.string(),
	stdoutTruncated: z.boolean(),
	stderrTruncated: z.boolean(),
	outcome: z.string(),
});

function parseBashResult(content: unknown): z.output<typeof bashResult> | null {
	return parseExecutorResult(content, bashResult);
}

const readResult = z.object({
	path: z.string(),
	content: z.string(),
	startLine: finiteNumber,
	linesRead: finiteNumber,
	truncated: z.boolean(),
});

function parseReadResult(content: unknown): z.output<typeof readResult> | null {
	return parseExecutorResult(content, readResult);
}

const writeResult = z.object({ path: z.string(), bytesWritten: finiteNumber });

function parseWriteResult(
	content: unknown,
): z.output<typeof writeResult> | null {
	return parseExecutorResult(content, writeResult);
}

const editResult = z.object({ path: z.string(), replacements: finiteNumber });

function parseEditResult(content: unknown): z.output<typeof editResult> | null {
	return parseExecutorResult(content, editResult);
}

const grepResult = z.object({
	matches: z.array(
		z.object({
			path: z.string(),
			line: finiteNumber,
			column: finiteNumber,
			text: z.string(),
		}),
	),
	truncated: z.boolean(),
});

function parseGrepResult(content: unknown): z.output<typeof grepResult> | null {
	return parseExecutorResult(content, grepResult);
}

/** Extract and parse the executor's structured JSON success text out of the
 * MCP result content; `null` on any surprise (omit upstream). */
function parseExecutorResult<T>(
	content: unknown,
	schema: z.ZodType<T>,
): T | null {
	const text = resultText(content);
	if (text === null) return null;
	try {
		const parsed = schema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
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
	return Buffer.byteLength(JSON.stringify(char), "utf8") - 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
