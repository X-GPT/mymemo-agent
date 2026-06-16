/**
 * Durable workspace path model. The durable store mirrors the sandbox workspace
 * but is keyed by user so it is isolated per user and per conversation:
 *
 *   users/{userId}/conversations/{conversationId}/work/
 *   users/{userId}/conversations/{conversationId}/output/
 *   users/{userId}/conversations/{conversationId}/docs/manifest.json
 *   users/{userId}/runs/{runId}/events.jsonl
 *
 * `userId`, `conversationId`, and `runId` all originate outside this module, so
 * each is validated before it is ever joined into a path. A value containing
 * `/`, `..`, or NUL could otherwise escape its subtree and reach another user's
 * or conversation's data. The charset is an allowlist, matching the daemon's
 * `assertValidConversationId`: anything outside it is rejected, never rewritten.
 */

import { join } from "node:path";

const VALID_ID = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 128;

/**
 * Throw if `value` is missing, too long, or contains any character that could
 * escape its directory. `label` names the field for the error message.
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
	assertValidId("userId", userId);
	assertValidId("conversationId", conversationId);
	const conversation = join(
		root,
		"users",
		userId,
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
	assertValidId("userId", userId);
	assertValidId("runId", runId);
	return join(root, "users", userId, "runs", runId, "events.jsonl");
}
