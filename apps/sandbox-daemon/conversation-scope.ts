/**
 * Conversation scope binding.
 *
 * A conversation has a SINGLE immutable document scope for its whole lifetime:
 * `global`, a specific `collection`, or a specific `document`. chat-api derives
 * the scope from the turn request (collection/summary ids) and signs it into the
 * per-turn document token; the gateway enforces it per fetch.
 *
 * The daemon hydrates fetched documents into the conversation's `docs/` dir,
 * which persists across turns in a reused sandbox/workspace (the powering force
 * behind `already_local`). If a later turn in the same conversation could use a
 * DIFFERENT — narrower — scope, it would read documents the broad-scope turn
 * already hydrated straight off disk, bypassing the gateway's per-turn scope
 * (MYM-39). The product invariant closes this: scope never changes within a
 * conversation. This module makes the daemon enforce that invariant rather than
 * trusting it — the first turn establishes the conversation's scope in
 * `scope.json` at the conversation root; any later turn whose scope differs is
 * rejected (fail closed), so a reused workspace can only ever hold documents
 * within the conversation's one fixed scope.
 *
 * The scope file is a sibling of `docs/`, so it persists exactly when the
 * hydrated docs do: if the workspace is wiped the docs are gone too (no leak)
 * and a fresh scope is re-established; if the workspace persists, so does the
 * scope it is bound to.
 *
 * Read/write follow the same correctness rules as the docs manifest: reads of a
 * present-but-unparseable file fail closed (throw), and writes are atomic
 * (temp file + rename) so a reader never observes a half-written scope.
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Current on-disk schema version. Bumped only on a breaking format change. */
export const CONVERSATION_SCOPE_VERSION = 1;

const SCOPE_FILENAME = "scope.json";

/** The document scope a conversation is bound to. Matches the turn request. */
export type ScopeType = "global" | "collection" | "document";

export interface ConversationScope {
	scopeType: ScopeType;
	/** Set only for `collection` scope; `null` otherwise. */
	collectionId: string | null;
	/** Set only for `document` scope; `null` otherwise. */
	summaryId: string | null;
}

/** The scope-relevant fields of a turn request, before normalization. */
export interface RequestedScope {
	scopeType?: string;
	collectionId?: string | null;
	summaryId?: string | null;
}

/** Raised when a scope file exists but cannot be parsed or validated. */
export class MalformedScopeError extends Error {
	constructor(message: string) {
		super(`Malformed conversation scope: ${message}`);
		this.name = "MalformedScopeError";
	}
}

/**
 * Raised when a turn's scope differs from the scope the conversation was first
 * bound to. Callers should treat this as a client error (a turn that must not
 * run), not a server fault.
 */
export class ConversationScopeMismatchError extends Error {
	constructor(
		readonly established: ConversationScope,
		readonly requested: ConversationScope,
	) {
		super(
			`Conversation scope is immutable: bound to ${scopeFingerprint(
				established,
			)}, turn requested ${scopeFingerprint(requested)}`,
		);
		this.name = "ConversationScopeMismatchError";
	}
}

/** Path to the scope file at a conversation's root directory. */
export function conversationScopePath(conversationDir: string): string {
	return join(conversationDir, SCOPE_FILENAME);
}

/**
 * Reduce a turn request's scope fields to the canonical {@link ConversationScope}.
 * Only the id relevant to the scope type is kept, so a stray id on a turn (e.g.
 * a `document`-scope turn that also carries a `collectionId`) cannot perturb the
 * binding. An unknown or missing scope type falls back to `global`.
 */
export function normalizeScope(requested: RequestedScope): ConversationScope {
	switch (requested.scopeType) {
		case "collection":
			return {
				scopeType: "collection",
				collectionId: requested.collectionId ?? null,
				summaryId: null,
			};
		case "document":
			return {
				scopeType: "document",
				collectionId: null,
				summaryId: requested.summaryId ?? null,
			};
		default:
			return { scopeType: "global", collectionId: null, summaryId: null };
	}
}

/** Canonical string identity of a scope, used for equality and error messages. */
export function scopeFingerprint(scope: ConversationScope): string {
	return `${scope.scopeType}|${scope.collectionId ?? ""}|${scope.summaryId ?? ""}`;
}

function parseScope(raw: string): ConversationScope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new MalformedScopeError(`invalid JSON (${(cause as Error).message})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new MalformedScopeError("expected a JSON object");
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== CONVERSATION_SCOPE_VERSION) {
		throw new MalformedScopeError(
			`unsupported version ${JSON.stringify(obj.version)}`,
		);
	}
	if (
		obj.scopeType !== "global" &&
		obj.scopeType !== "collection" &&
		obj.scopeType !== "document"
	) {
		throw new MalformedScopeError(
			`invalid scopeType ${JSON.stringify(obj.scopeType)}`,
		);
	}
	if (obj.collectionId !== null && typeof obj.collectionId !== "string") {
		throw new MalformedScopeError("`collectionId` must be a string or null");
	}
	if (obj.summaryId !== null && typeof obj.summaryId !== "string") {
		throw new MalformedScopeError("`summaryId` must be a string or null");
	}
	return {
		scopeType: obj.scopeType,
		collectionId: obj.collectionId,
		summaryId: obj.summaryId,
	};
}

/**
 * Read the scope a conversation is bound to, or `null` if none is established
 * yet. Throws {@link MalformedScopeError} if the file exists but is unparseable,
 * so callers fail closed instead of silently rebinding a corrupt scope.
 */
export function readConversationScope(
	conversationDir: string,
): ConversationScope | null {
	let raw: string;
	try {
		raw = readFileSync(conversationScopePath(conversationDir), "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw cause;
	}
	return parseScope(raw);
}

/**
 * Atomically write the conversation's scope file. Creates the conversation
 * directory if needed (the scope is bound before the rest of the workspace tree
 * is materialized). Writes a sibling temp file and renames it into place so a
 * partial write can never be observed as `scope.json`.
 */
function writeConversationScope(
	conversationDir: string,
	scope: ConversationScope,
): void {
	mkdirSync(conversationDir, { recursive: true });
	const target = conversationScopePath(conversationDir);
	const tmp = `${target}.tmp`;
	const payload = { version: CONVERSATION_SCOPE_VERSION, ...scope };
	try {
		writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		renameSync(tmp, target);
	} catch (cause) {
		rmSync(tmp, { force: true });
		throw cause;
	}
}

/**
 * Establish or enforce the conversation's immutable scope for this turn.
 *
 * - First turn (no scope file): records the requested scope and returns it.
 * - Later turn with the SAME scope: a no-op; returns the established scope.
 * - Later turn with a DIFFERENT scope: throws
 *   {@link ConversationScopeMismatchError} and writes nothing.
 *
 * Returns the scope the conversation is bound to.
 */
export function bindConversationScope(
	conversationDir: string,
	requested: RequestedScope,
): ConversationScope {
	const requestedScope = normalizeScope(requested);
	const established = readConversationScope(conversationDir);
	if (established === null) {
		writeConversationScope(conversationDir, requestedScope);
		return requestedScope;
	}
	if (scopeFingerprint(established) !== scopeFingerprint(requestedScope)) {
		throw new ConversationScopeMismatchError(established, requestedScope);
	}
	return established;
}
