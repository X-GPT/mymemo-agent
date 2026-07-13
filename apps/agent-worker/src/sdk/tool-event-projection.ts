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
 * Today only Bash has a projection (the ADR-0009 tracer bullet); the other
 * seven executor tools are allowlisted names whose events are omitted until
 * their projections land.
 */

/** Hard cap on one tool event: 16 KiB of UTF-8 JSON after projection. An event
 * is never split across frames; what cannot fit capped is omitted. */
export const TOOL_EVENT_MAX_JSON_BYTES = 16_384;

/** Serialized-JSON budgets per preview field, chosen so a fully populated Bash
 * event stays well under the event cap by construction. */
const COMMAND_PREVIEW_MAX_JSON_BYTES = 2_048;
const CWD_PREVIEW_MAX_JSON_BYTES = 512;
const OUTPUT_PREVIEW_MAX_JSON_BYTES = 6_144;
const OUTCOME_MAX_JSON_BYTES = 64;

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
	if (tool !== "Bash") {
		return { ok: false, reason: `no argument projection for tool ${tool}` };
	}
	const fields = isRecord(input) ? input : {};
	const args: Record<string, unknown> = {};
	let clipped = false;
	if (typeof fields.command === "string") {
		const command = clampJsonString(
			fields.command,
			COMMAND_PREVIEW_MAX_JSON_BYTES,
		);
		args.command = command.text;
		clipped ||= command.clipped;
	}
	if (typeof fields.cwd === "string") {
		const cwd = clampJsonString(fields.cwd, CWD_PREVIEW_MAX_JSON_BYTES);
		args.cwd = cwd.text;
		clipped ||= cwd.clipped;
	}
	if (
		typeof fields.timeoutMs === "number" &&
		Number.isFinite(fields.timeoutMs)
	) {
		args.timeoutMs = fields.timeoutMs;
	}
	return fitOrOmit({ tool, arguments: args, truncated: clipped });
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
	if (tool !== "Bash") {
		return { ok: false, reason: `no result projection for tool ${tool}` };
	}
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
		tool,
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
	const text = resultText(content);
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const exitCode = parsed.exitCode;
	if (
		exitCode !== null &&
		!(typeof exitCode === "number" && Number.isFinite(exitCode))
	) {
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
 * this unreachable for Bash; it guards future projections and shape drift.
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
