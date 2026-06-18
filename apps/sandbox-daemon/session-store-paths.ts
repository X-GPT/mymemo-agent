/**
 * Durable session-transcript path scheme used by the agent-side adapter
 * (`session-store.ts`, which writes the files). Kept free of the Claude Agent
 * SDK import so it can live in the daemon bundle without pulling the SDK in.
 *
 * Layout (matches the chat-api `WorkspaceStore` model):
 *   {root}/users/{sha256(userId)}/conversations/{conversationId}/sessions/
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

const VALID_ID = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 128;

/**
 * Throw unless `value` is a non-empty, length-bounded id from the safe charset.
 * Used for `conversationId` and the SDK `sessionId`, both of which arrive in a
 * known-safe shape (chat-api charset / SDK UUID). A malformed value is rejected,
 * never rewritten, so the stored path always matches the id the caller used.
 */
export function assertSafeId(
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
 * Hash a `userId` into a fixed-length, path-safe segment. The member code has
 * no enforced charset or length, so it is hashed rather than used verbatim:
 * any input maps to `[0-9a-f]{64}`, distinct ids map to distinct segments
 * (per-user isolation), and nothing can traverse out of `users/`.
 */
export function encodeUserSegment(userId: unknown): string {
	if (typeof userId !== "string" || userId.length === 0) {
		throw new Error(`Invalid userId: ${JSON.stringify(userId)}`);
	}
	return createHash("sha256").update(userId, "utf8").digest("hex");
}

/**
 * Resolve the per-conversation `sessions/` directory under the durable root.
 * The agent's FileSystemSessionStore is bound to one {user, conversation} at
 * construction and only ever reads/writes this subtree, so transcripts stay
 * structurally separated per user and per conversation.
 */
export function resolveConversationSessionsDir(
	root: string,
	userId: string,
	conversationId: string,
): string {
	assertSafeId("conversationId", conversationId);
	return join(
		root,
		"users",
		encodeUserSegment(userId),
		"conversations",
		conversationId,
		"sessions",
	);
}
