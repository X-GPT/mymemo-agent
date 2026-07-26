import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
	ownedRunConditions,
	type RunMutationOwner,
	rejectRunFence,
} from "./run-ownership";
import type { DbTx } from "./run-store";
import { agentSessions, runs } from "./schema";

/**
 * Table-level helpers over `agent_sessions` — the raw read/write path the
 * worker's Claude Agent SDK `SessionStore` adapter is built on (ADR-0005, Task
 * 7.3). They live here, SDK-free, so the schema and its SQL stay in the shared
 * package over one drizzle instance; the adapter that `implements SessionStore`
 * (and imports the SDK types) lives in agent-worker and delegates to these.
 *
 * Every helper is keyed by `conversationId` — the stable identity the adapter
 * binds each call to — plus the SDK's `(sessionId, subpath)`. `projectKey` is
 * stored for fidelity with the SDK's cwd-derived key but is never a lookup key:
 * conversation id is 1:1 with a conversation's transcripts and does not depend
 * on reconstructing the SDK's cwd→key sanitization.
 */

/**
 * A transcript entry as the SessionStore adapter observes it: an opaque JSON
 * blob (one JSONL line) that may carry a `uuid` for dedup. Stored and returned
 * as-is; only deep-equality round-tripping is guaranteed (jsonb may reorder
 * keys), which is all the SDK requires.
 */
export interface AgentSessionEntry {
	uuid?: string;
	[key: string]: unknown;
}

/**
 * Identifies one transcript within a conversation. `subpath` undefined names
 * the main transcript (stored as `''`); a non-empty `subagents/agent-…` value
 * names a subagent transcript.
 */
export interface AgentSessionRef {
	conversationId: string;
	projectKey: string;
	sessionId: string;
	subpath?: string;
}

/** The active Run ownership that authorizes one SDK-requested transcript
 * mutation. Conversation-deletion cleanup deliberately does not use this. */
export interface AgentSessionMutationOwner extends RunMutationOwner {}

/** The main transcript's stored subpath — the empty string, since the SDK's
 * "omit the field" convention is not representable in a NOT NULL column. */
const MAIN_SUBPATH = "";

function normalizeSubpath(subpath: string | undefined): string {
	return subpath ?? MAIN_SUBPATH;
}

/**
 * Mirror a batch of transcript entries, insertion-ordered by the `bigserial`
 * id. Deduplicates by `entry.uuid`: `ON CONFLICT DO NOTHING` against the unique
 * `(conversation, session, subpath, uuid)` index drops a re-delivered uuid,
 * while uuid-less entries (NULL, distinct in the index) always insert. Empty
 * batches no-op.
 */
export async function appendAgentSessionEntriesTx(
	db: Database,
	ref: AgentSessionRef,
	entries: AgentSessionEntry[],
	owner: AgentSessionMutationOwner,
): Promise<void> {
	const subpath = normalizeSubpath(ref.subpath);
	if (ref.conversationId !== owner.conversationId) {
		rejectRunFence(owner, "session append");
	}
	await withOwnedSessionMutation(db, owner, "session append", async (tx) => {
		if (entries.length === 0) return;
		await tx
			.insert(agentSessions)
			.values(
				entries.map((entry) => ({
					conversationId: ref.conversationId,
					projectKey: ref.projectKey,
					sessionId: ref.sessionId,
					subpath,
					uuid: typeof entry.uuid === "string" ? entry.uuid : null,
					entry,
				})),
			)
			.onConflictDoNothing();
	});
}

/**
 * Load one transcript's entries in append order for resume, or `null` when it
 * was never written. Keyed on `(conversationId, sessionId, subpath)` — not
 * `projectKey` — so a later turn resumes correctly regardless of how the SDK
 * derived the current projectKey.
 */
export async function loadAgentSessionEntriesTx(
	db: Database,
	ref: AgentSessionRef,
): Promise<AgentSessionEntry[] | null> {
	const rows = await db
		.select({ entry: agentSessions.entry })
		.from(agentSessions)
		.where(
			transcriptWhere(
				ref.conversationId,
				ref.sessionId,
				normalizeSubpath(ref.subpath),
			),
		)
		.orderBy(asc(agentSessions.id));
	if (rows.length === 0) return null;
	return rows.map((row) => row.entry as AgentSessionEntry);
}

/**
 * List a conversation's sessions (main transcripts only) with each session's
 * last-write time as Unix epoch milliseconds. The SDK sorts by mtime
 * descending; order here is unspecified.
 */
export async function listAgentSessionsTx(
	db: Database,
	input: { conversationId: string },
): Promise<Array<{ sessionId: string; mtime: number }>> {
	const rows = await db
		.select({
			sessionId: agentSessions.sessionId,
			mtime: sql<string | Date>`max(${agentSessions.createdAt})`,
		})
		.from(agentSessions)
		.where(
			and(
				eq(agentSessions.conversationId, input.conversationId),
				eq(agentSessions.subpath, MAIN_SUBPATH),
			),
		)
		.groupBy(agentSessions.sessionId);
	return rows.map((row) => ({
		sessionId: row.sessionId,
		mtime: new Date(row.mtime).getTime(),
	}));
}

/**
 * List the non-empty subpaths (subagent transcripts) under one session, so
 * resume can discover and materialize them.
 */
export async function listAgentSessionSubkeysTx(
	db: Database,
	input: { conversationId: string; sessionId: string },
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ subpath: agentSessions.subpath })
		.from(agentSessions)
		.where(
			and(
				eq(agentSessions.conversationId, input.conversationId),
				eq(agentSessions.sessionId, input.sessionId),
				sql`${agentSessions.subpath} <> ${MAIN_SUBPATH}`,
			),
		);
	return rows.map((row) => row.subpath);
}

/**
 * Delete a session's transcripts. With `subpath`, only that subpath is removed;
 * without it, the whole session (main transcript and every subagent) is removed
 * — the SDK's "delete a session" semantics.
 */
export async function deleteAgentSessionTx(
	db: Database,
	input: { conversationId: string; sessionId: string; subpath?: string },
	owner: AgentSessionMutationOwner,
): Promise<void> {
	if (input.conversationId !== owner.conversationId) {
		rejectRunFence(owner, "session delete");
	}
	await withOwnedSessionMutation(db, owner, "session delete", async (tx) => {
		await tx
			.delete(agentSessions)
			.where(
				transcriptWhere(input.conversationId, input.sessionId, input.subpath),
			);
	});
}

/**
 * Delete every transcript for a conversation. The conversation-scoped retention
 * path (ADR-0005, amended by ADR-0007): conversation deletion drops the
 * conversation's model-side memory, run by the periodic cleanup loop's
 * deleted-conversation sweep.
 */
export async function deleteConversationAgentSessionsTx(
	db: Database,
	input: { conversationId: string },
): Promise<void> {
	await db
		.delete(agentSessions)
		.where(eq(agentSessions.conversationId, input.conversationId));
}

async function withOwnedSessionMutation(
	db: Database,
	owner: AgentSessionMutationOwner,
	operation: string,
	mutate: (tx: DbTx) => Promise<void>,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [owned] = await tx
			.select({ runId: runs.runId })
			.from(runs)
			.where(ownedRunConditions(owner))
			.for("share");
		if (!owned) {
			rejectRunFence(owner, operation);
		}
		await mutate(tx);
	});
}

/**
 * Match one transcript. An omitted `subpath` matches every subpath of the
 * session (used by whole-session delete); a given `subpath` — including the
 * main transcript's `''` — matches exactly that one.
 */
function transcriptWhere(
	conversationId: string,
	sessionId: string,
	subpath: string | undefined,
) {
	const conditions = [
		eq(agentSessions.conversationId, conversationId),
		eq(agentSessions.sessionId, sessionId),
	];
	if (subpath !== undefined) {
		conditions.push(eq(agentSessions.subpath, subpath));
	}
	return and(...conditions);
}
