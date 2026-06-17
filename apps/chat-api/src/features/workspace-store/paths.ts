/**
 * Durable workspace path model. The durable store mirrors the sandbox workspace
 * but is keyed by user so it is isolated per user and per conversation:
 *
 *   users/{userId}/conversations/{conversationId}/work/
 *   users/{userId}/conversations/{conversationId}/output/
 *   users/{userId}/conversations/{conversationId}/docs/manifest.json
 *   users/{userId}/runs/{runId}/events.jsonl
 *
 * Each id is made path-safe before it is ever joined into a path, so a value
 * containing `/`, `..`, or NUL cannot escape its subtree and reach another
 * user's or conversation's data:
 *   - `conversationId` and `runId` are allocated by chat-api in a known-safe
 *     shape (the chat schema restricts `conversationId` to the same charset;
 *     `runId` is a UUID), so they are validated against an allowlist and a
 *     malformed value is rejected, never rewritten — matching the daemon's
 *     `assertValidConversationId`.
 *   - `userId` is the caller-supplied member code, which has no enforced
 *     charset and may exceed a filesystem name limit, so it cannot be used as a
 *     path segment directly. It is hashed into a fixed-length, path-safe segment
 *     instead (see `encodeUserSegment`).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

const VALID_ID = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 128;

/**
 * Throw if `value` is missing, too long, or contains any character that could
 * escape its directory. `label` names the field for the error message. Use only
 * for ids chat-api allocates in a known-safe shape (`conversationId`, `runId`).
 */
export function assertValidId(
	label: string,
	value: unknown,
): asserts value is string {
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
 * Derive a path-safe directory segment from a `userId` (member code). The member
 * code's charset and length are unconstrained, so it is hashed rather than used
 * verbatim: any input maps to a fixed `[0-9a-f]{64}` segment that cannot
 * traverse out of the `users/` directory, and distinct ids map to distinct
 * segments, so per-user isolation holds. Throws only on a missing/empty id.
 */
export function encodeUserSegment(userId: unknown): string {
	if (typeof userId !== "string" || userId.length === 0) {
		throw new Error(`Invalid userId: ${JSON.stringify(userId)}`);
	}
	return createHash("sha256").update(userId, "utf8").digest("hex");
}

export interface DurableConversationPaths {
	/** users/{userId}/conversations/{conversationId} */
	conversation: string;
	/** .../work */
	work: string;
	/** .../output */
	output: string;
	/** .../docs */
	docs: string;
}

/**
 * Compute the durable paths for a conversation. Pure: validates the ids and
 * joins paths, but touches no filesystem.
 */
export function resolveDurableConversationPaths(
	root: string,
	userId: string,
	conversationId: string,
): DurableConversationPaths {
	assertValidId("conversationId", conversationId);
	const conversation = join(
		root,
		"users",
		encodeUserSegment(userId),
		"conversations",
		conversationId,
	);
	return {
		conversation,
		work: join(conversation, "work"),
		output: join(conversation, "output"),
		docs: join(conversation, "docs"),
	};
}

/**
 * Compute the durable NDJSON event-log path for a run. Pure: validates the ids
 * and joins paths, but touches no filesystem.
 */
export function resolveDurableRunEventsPath(
	root: string,
	userId: string,
	runId: string,
): string {
	assertValidId("runId", runId);
	return join(
		root,
		"users",
		encodeUserSegment(userId),
		"runs",
		runId,
		"events.jsonl",
	);
}
