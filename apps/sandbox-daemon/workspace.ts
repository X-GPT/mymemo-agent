/**
 * Sandbox workspace layout. The daemon materializes a fixed directory tree per
 * conversation before spawning the agent:
 *
 *   /workspace/
 *     system/
 *     conversations/
 *       {conversationId}/
 *         docs/
 *         work/      <- the agent's working directory (cwd)
 *         output/
 *
 * The agent runs from the conversation's `work/` dir. `conversationId` arrives
 * from the untrusted turn request, so it is validated before it is ever joined
 * into a path — a value containing `/`, `..`, or NUL could otherwise escape the
 * conversation subtree.
 *
 * The root is env-overridable (`SANDBOX_WORKSPACE_ROOT`) so tests can point it
 * at a temp dir instead of the host's real `/workspace`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Must stay in sync with child-spawn's WORKSPACE_ROOT and the sandbox template's
// setWorkdir (apps/chat-api/sandbox-template/template.ts).
const DEFAULT_WORKSPACE_ROOT = "/workspace";

// conversationId is allocated by chat-api (UUID/nanoid-shaped). Restrict it to a
// conservative charset so no value can traverse out of its conversation dir.
// This is an allowlist, not an escape: anything outside it is rejected, never
// rewritten, so the path the daemon creates always matches the id chat-api uses.
const VALID_CONVERSATION_ID = /^[A-Za-z0-9_-]+$/;
const MAX_CONVERSATION_ID_LENGTH = 128;

export function getWorkspaceRoot(): string {
	return process.env.SANDBOX_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT;
}

/**
 * Throw if `conversationId` is missing, too long, or contains any character
 * that could escape the conversation workspace. Callers should treat a throw as
 * a client error (malformed turn request), not a server fault.
 */
export function assertValidConversationId(
	conversationId: unknown,
): asserts conversationId is string {
	if (
		typeof conversationId !== "string" ||
		conversationId.length === 0 ||
		conversationId.length > MAX_CONVERSATION_ID_LENGTH ||
		!VALID_CONVERSATION_ID.test(conversationId)
	) {
		throw new Error(
			`Invalid conversationId: ${JSON.stringify(conversationId)}`,
		);
	}
}

export interface ConversationWorkspace {
	/** /workspace */
	root: string;
	/** /workspace/system */
	system: string;
	/** /workspace/conversations/{conversationId} */
	conversation: string;
	/** /workspace/conversations/{conversationId}/docs */
	docs: string;
	/** /workspace/conversations/{conversationId}/work — the agent's cwd */
	work: string;
	/** /workspace/conversations/{conversationId}/output */
	output: string;
}

/**
 * Compute the workspace paths for a conversation. Pure: validates the id and
 * joins paths, but touches no filesystem.
 */
export function resolveConversationWorkspace(
	conversationId: string,
): ConversationWorkspace {
	assertValidConversationId(conversationId);
	const root = getWorkspaceRoot();
	const conversation = join(root, "conversations", conversationId);
	return {
		root,
		system: join(root, "system"),
		conversation,
		docs: join(conversation, "docs"),
		work: join(conversation, "work"),
		output: join(conversation, "output"),
	};
}

/**
 * Create the workspace directory tree for a conversation and return its paths.
 * Idempotent (recursive mkdir). Must be called before spawning the agent so the
 * cwd exists for bwrap's rw bind.
 */
export function createConversationWorkspace(
	conversationId: string,
): ConversationWorkspace {
	const ws = resolveConversationWorkspace(conversationId);
	mkdirSync(ws.system, { recursive: true });
	mkdirSync(ws.docs, { recursive: true });
	mkdirSync(ws.work, { recursive: true });
	mkdirSync(ws.output, { recursive: true });
	return ws;
}
