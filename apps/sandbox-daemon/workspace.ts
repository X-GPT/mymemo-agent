/**
 * Sandbox workspace layout. The daemon materializes a fixed directory tree per
 * conversation before spawning the agent:
 *
 *   /workspace/
 *     system/
 *     conversations/
 *       {conversationId}/
 *         docs/
 *         work/          <- the agent's working directory (cwd)
 *         output/
 *         claude-config/ <- the agent SDK's CLAUDE_CONFIG_DIR (config + transcripts)
 *
 * `claude-config/` is the per-conversation home the daemon points the Claude
 * Agent SDK at via CLAUDE_CONFIG_DIR. It is a SIBLING of `work/`, not a child,
 * and deliberately NOT named `.claude`: the SDK reads project-level config from
 * `<cwd>/.claude` (settings, commands, agents, CLAUDE.md), so a child named
 * `.claude` would collide the SDK's own state (`projects/`, transcripts, …) with
 * the agent's project config. Keeping it a distinct sibling separates the two.
 *
 * The agent runs from the conversation's `work/` dir. `conversationId` arrives
 * from the untrusted turn request, so it is validated before it is ever joined
 * into a path — a value containing `/`, `..`, or NUL could otherwise escape the
 * conversation subtree.
 *
 * The root is injected (`DaemonConfig.workspaceRoot`, default `/workspace`) so
 * tests can point it at a temp dir instead of the host's real `/workspace`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

// conversationId is allocated by chat-api (UUID/nanoid-shaped). Restrict it to a
// conservative charset so no value can traverse out of its conversation dir.
// This is an allowlist, not an escape: anything outside it is rejected, never
// rewritten, so the path the daemon creates always matches the id chat-api uses.
const VALID_CONVERSATION_ID = /^[A-Za-z0-9_-]+$/;
const MAX_CONVERSATION_ID_LENGTH = 128;

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
	/** /workspace/conversations/{conversationId}/claude-config — the agent SDK's CLAUDE_CONFIG_DIR */
	claudeConfig: string;
}

/**
 * Compute the workspace paths for a conversation under `workspaceRoot`. Pure:
 * validates the id and joins paths, but touches no filesystem.
 */
export function resolveConversationWorkspace(
	conversationId: string,
	workspaceRoot: string,
): ConversationWorkspace {
	assertValidConversationId(conversationId);
	const conversation = join(workspaceRoot, "conversations", conversationId);
	return {
		root: workspaceRoot,
		system: join(workspaceRoot, "system"),
		conversation,
		docs: join(conversation, "docs"),
		work: join(conversation, "work"),
		output: join(conversation, "output"),
		claudeConfig: join(conversation, "claude-config"),
	};
}

/**
 * Create the workspace directory tree for a conversation and return its paths.
 * Idempotent (recursive mkdir). Must be called before spawning the agent so the
 * cwd and per-conversation SDK config home exist when the agent runs.
 */
export function createConversationWorkspace(
	conversationId: string,
	workspaceRoot: string,
): ConversationWorkspace {
	const ws = resolveConversationWorkspace(conversationId, workspaceRoot);
	mkdirSync(ws.system, { recursive: true });
	mkdirSync(ws.docs, { recursive: true });
	mkdirSync(ws.work, { recursive: true });
	mkdirSync(ws.output, { recursive: true });
	mkdirSync(ws.claudeConfig, { recursive: true });
	return ws;
}
