import { and, asc, eq, sql } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import {
	ownedRunConditions,
	type RunMutationOwner,
	rejectRunFence,
} from "./run-ownership";
import { agentSessions, runs } from "./schema";

/**
 * SDK-free persistence helpers over `agent_sessions`, used by the worker's
 * Claude Agent SDK `SessionStore` adapter (ADR-0005, Task 7.3). Append and
 * SDK-requested delete transactions validate and lock active-Run ownership
 * `FOR SHARE` *before* the mutation: a rejected fence writes nothing at all,
 * and the lock then holds ownership stable through commit, so the mutation
 * cannot be undercut by a concurrent terminal transition. Reads and
 * administrative Conversation deletion are deliberately unfenced. The helpers
 * live here so the schema, fence, and SQL use the shared package's one Drizzle
 * instance; the adapter that imports SDK types lives in agent-worker and
 * delegates here.
 *
 * Mutations take `conversationId` only from their Run owner — the stable
 * identity the adapter binds each call to — plus the SDK's `(sessionId,
 * subpath)`. `projectKey` is stored for fidelity with the SDK's cwd-derived key
 * but is never a lookup key: conversation id is 1:1 with a conversation's
 * transcripts and does not depend on reconstructing the SDK's cwd→key
 * sanitization.
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
 * Identifies one SDK transcript within its Run-bound conversation. `subpath`
 * undefined names the main transcript (stored as `''`); a non-empty
 * `subagents/agent-…` value names a subagent transcript.
 */
export interface AgentSessionRef {
	projectKey: string;
	sessionId: string;
	subpath?: string;
}

/** A transcript read ref, whose unfenced lookup must carry its Conversation. */
export interface ConversationAgentSessionRef extends AgentSessionRef {
	conversationId: string;
}

/** The main transcript's stored subpath — the empty string, since the SDK's
 * "omit the field" convention is not representable in a NOT NULL column. */
const MAIN_SUBPATH = "";

function normalizeSubpath(subpath: string | undefined): string {
	return subpath ?? MAIN_SUBPATH;
}

/** Whether an SDK key names the main transcript rather than a subagent. */
export function isMainAgentSessionRef(
	ref: Pick<AgentSessionRef, "subpath">,
): boolean {
	return normalizeSubpath(ref.subpath) === MAIN_SUBPATH;
}

/**
 * Mirror a batch of transcript entries, insertion-ordered by the `bigserial`
 * id. Deduplicates by `entry.uuid`: `ON CONFLICT DO NOTHING` against the unique
 * `(conversation, session, subpath, uuid)` index drops a re-delivered uuid,
 * while uuid-less entries (NULL, distinct in the index) always insert. Empty
 * batches write nothing but still validate the bound Run owner.
 */
export async function appendAgentSessionEntriesTx(
	db: Database,
	input: {
		owner: RunMutationOwner;
		ref: AgentSessionRef;
		entries: AgentSessionEntry[];
	},
): Promise<void> {
	const { owner, ref, entries } = input;
	if (entries.length === 0) {
		await assertOwnedRunForNoop(db, owner, "session append");
		return;
	}
	const subpath = normalizeSubpath(ref.subpath);
	await db.transaction(async (tx) => {
		await lockOwnedRun(tx, owner, "session append");
		await tx
			.insert(agentSessions)
			.values(
				entries.map((entry) => ({
					conversationId: owner.conversationId,
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
	ref: ConversationAgentSessionRef,
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
	input: {
		owner: RunMutationOwner;
		ref: { sessionId: string; subpath?: string };
	},
): Promise<void> {
	const { owner, ref } = input;
	await db.transaction(async (tx) => {
		await lockOwnedRun(tx, owner, "session delete");
		await tx
			.delete(agentSessions)
			.where(transcriptWhere(owner.conversationId, ref.sessionId, ref.subpath));
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

/**
 * Validate and lock ownership before the mutation. A failed fence rejects the
 * transaction with nothing written; a successful `FOR SHARE` lock keeps the
 * ownership row stable through commit, so a concurrent terminal transition
 * cannot clear ownership underneath the write.
 */
async function lockOwnedRun(
	tx: DbTx,
	owner: RunMutationOwner,
	operation: string,
): Promise<void> {
	const [owned] = await tx
		.select({ runId: runs.runId })
		.from(runs)
		.where(ownedRunConditions(owner))
		.for("share");
	if (!owned) {
		rejectRunFence(owner, operation);
	}
}

/**
 * Validate a mutation-shaped no-op without opening a transaction. There is no
 * write to protect with a lock, but the bound SessionStore call still rejects
 * a worker whose ownership lease is no longer active.
 */
async function assertOwnedRunForNoop(
	db: Database,
	owner: RunMutationOwner,
	operation: string,
): Promise<void> {
	const [owned] = await db
		.select({ runId: runs.runId })
		.from(runs)
		.where(ownedRunConditions(owner));
	if (!owned) rejectRunFence(owner, operation);
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
