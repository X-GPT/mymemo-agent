/**
 * Local filesystem adapter for the Claude Agent SDK `SessionStore` (the
 * transcript-mirror hook). The SDK keeps its authoritative JSONL transcript
 * under `~/.claude/projects/` and, after each local write succeeds, mirrors the
 * same entries here via `append`. On a fresh or recycled sandbox the SDK calls
 * `load` once before spawning its subprocess to materialize a prior transcript,
 * which is how `resume: agentSessionId` survives a sandbox that no longer has
 * the local copy.
 *
 * Storage is keyed by user, conversation, and SDK session id following the same
 * durable path model the chat-api `WorkspaceStore` uses:
 *
 *   {root}/users/{sha256(userId)}/conversations/{conversationId}/sessions/{sessionId}.jsonl
 *
 * `userId` and `conversationId` are bound at construction from the trusted turn
 * request — they are NOT taken from the SDK-provided key, whose `projectKey` is
 * derived from the agent cwd and carries no tenancy meaning. Per-user and
 * per-conversation isolation therefore holds structurally: a store built for
 * one {user, conversation} can only ever read or write that subtree. The
 * SDK-supplied `sessionId`/`subpath` are validated before they are joined into
 * a path so a malformed value cannot escape the conversation's `sessions/` dir.
 *
 * Subagent transcript resume is intentionally unsupported: the sandbox agent
 * runs without the Task tool, so it never spawns subagents and the SDK never
 * needs `listSubkeys` to discover their transcripts. `append`/`load` still
 * accept a `subpath` (validated) so a stray subagent batch is stored rather
 * than lost, but no `listSubkeys` is implemented.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

const VALID_ID = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 128;

/**
 * Throw unless `value` is a non-empty, length-bounded id from the safe charset.
 * Used for `conversationId` and the SDK `sessionId`, both of which arrive in a
 * known-safe shape (chat-api charset / SDK UUID). A malformed value is rejected,
 * never rewritten, so the stored path always matches the id the caller used.
 */
function assertSafeId(label: string, value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_ID_LENGTH ||
		!VALID_ID.test(value)
	) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
}

/**
 * Validate an optional `subpath` (e.g. `subagents/agent-7`). `/` is allowed as
 * a separator, but every segment must be from the safe charset — this rejects
 * `..`, absolute paths, and NUL before the subpath is joined into a file path.
 */
function assertSafeSubpath(subpath: string): void {
	const segments = subpath.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || !VALID_ID.test(segment)) {
			throw new Error(`Invalid session subpath: ${JSON.stringify(subpath)}`);
		}
	}
}

/**
 * Hash a `userId` into a fixed-length, path-safe segment. The member code has
 * no enforced charset or length, so it is hashed rather than used verbatim:
 * any input maps to `[0-9a-f]{64}`, distinct ids map to distinct segments
 * (per-user isolation), and nothing can traverse out of `users/`.
 */
function encodeUserSegment(userId: string): string {
	return createHash("sha256").update(userId, "utf8").digest("hex");
}

export interface SessionStoreConfig {
	/** Durable root dir. In the sandbox this is bound rw; in tests a temp dir. */
	rootDir: string;
	/** Trusted member code from the turn request. */
	userId: string;
	/** Trusted conversation id from the turn request. */
	conversationId: string;
}

export class FileSystemSessionStore implements SessionStore {
	private readonly sessionsDir: string;

	constructor(config: SessionStoreConfig) {
		if (typeof config.userId !== "string" || config.userId.length === 0) {
			throw new Error(`Invalid userId: ${JSON.stringify(config.userId)}`);
		}
		assertSafeId("conversationId", config.conversationId);
		this.sessionsDir = join(
			config.rootDir,
			"users",
			encodeUserSegment(config.userId),
			"conversations",
			config.conversationId,
			"sessions",
		);
	}

	/**
	 * Resolve the JSONL file for a key. Ignores `key.projectKey` (SDK-derived
	 * from cwd, not tenancy) and uses the {user, conversation} bound at
	 * construction. Validates the SDK-supplied `sessionId`/`subpath` so neither
	 * can escape `sessionsDir`.
	 */
	private fileFor(key: SessionKey): string {
		assertSafeId("sessionId", key.sessionId);
		if (key.subpath === undefined) {
			return join(this.sessionsDir, `${key.sessionId}.jsonl`);
		}
		assertSafeSubpath(key.subpath);
		return join(this.sessionsDir, key.sessionId, `${key.subpath}.jsonl`);
	}

	/**
	 * Append a transcript batch as JSONL, preserving call order. One
	 * `appendFileSync` per batch keeps entries within a batch contiguous and in
	 * order; concurrent processes interleave by commit time, per the contract.
	 */
	async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const file = this.fileFor(key);
		mkdirSync(dirname(file), { recursive: true });
		const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
		appendFileSync(file, lines, "utf8");
	}

	/**
	 * Load a full session for resume. Returns the appended entry sequence, or
	 * `null` for a session that was never written (the SDK then starts fresh).
	 */
	async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
		const file = this.fileFor(key);
		if (!existsSync(file)) return null;
		const raw = readFileSync(file, "utf8");
		const entries: SessionStoreEntry[] = [];
		for (const line of raw.split("\n")) {
			if (line.length === 0) continue;
			try {
				entries.push(JSON.parse(line) as SessionStoreEntry);
			} catch {
				// A transcript line can be truncated if a prior turn was SIGKILL'd
				// (idle/max-turn watchdog) mid-append. Tolerate it: skip the
				// unparseable line so resume degrades to the intact prefix, rather
				// than the SDK failing the whole turn when load() rejects. Logged so
				// the corruption is observable.
				console.error(
					"skipping unparseable session transcript line on load (truncated write?)",
				);
			}
		}
		return entries;
	}
}

/**
 * Build a session store from config, or `null` when durable session storage is
 * not configured (no root) — the caller then runs with the SDK's default local
 * transcript only, today's behavior.
 */
export function createSessionStore(
	config: Partial<SessionStoreConfig>,
): FileSystemSessionStore | null {
	if (!config.rootDir || !config.userId || !config.conversationId) return null;
	return new FileSystemSessionStore({
		rootDir: config.rootDir,
		userId: config.userId,
		conversationId: config.conversationId,
	});
}

/** Env var naming the durable session-transcript root. Unset = disabled. */
export const SESSION_STORE_ROOT_ENV = "AGENT_SESSION_STORE_ROOT";
