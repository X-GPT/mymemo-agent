/**
 * PROTOTYPE — throwaway. See README.md. Delete after `/to-spec`.
 *
 * The portable half of the prototype: the exact SQL under test for ADR-0015's
 * Conversation-level ownership with an epoch fence. Pure — it takes a query
 * runner, returns data, and does no I/O of its own. The TUI and the two
 * harnesses are the throwaway shell around this; if a shape survives, this file
 * is the thing that gets lifted into `run-store.ts` / `runtime-store.ts`.
 */

/** Structural stand-in for a `pg` Client/PoolClient, so this file needs no deps. */
export interface Queryable {
	query<R = Record<string, unknown>>(
		sql: string,
		values?: unknown[],
	): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface ConversationRef {
	userId: string;
	conversationId: string;
}

export interface Claim extends ConversationRef {
	epoch: number;
	ownerUntil: Date;
}

export interface RunRef {
	runId: string;
	createdAt: Date;
}

/**
 * The typed fence outcome ADR-0015 names as a prerequisite (Track A #4). The
 * drain has to tell "I lost the lease — halt, do not release" from "the Run went
 * terminal under me — skip it and continue", and today's opaque RunFenceError
 * cannot.
 */
export type FenceOutcome<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			rejected: "lease";
			epoch: number | null;
			ownerUntil: Date | null;
	  }
	| { ok: false; rejected: "status"; current: string }
	| { ok: false; rejected: "gone" };

/** Candidate-selection shapes for the Claim. §3.1 asks which of these are legal
 * and plan sanely; `join` is the one ADR-0015 sketches. */
export type ClaimShape = "join" | "select_then_update" | "exists_min";

export const CLAIM_SHAPES: ClaimShape[] = [
	"join",
	"select_then_update",
	"exists_min",
];

// ---------------------------------------------------------------------------
// Candidate selection — the part §3.1 is about.
// ---------------------------------------------------------------------------

/**
 * ADR-0015's sketch: one UPDATE whose candidate subquery joins `runs`, orders by
 * `r.created_at`, and locks ONLY the `conversations` side. The open questions are
 * whether `FOR UPDATE OF c` is legal here at all, and whether the LockRows node
 * ends up above or below the Sort (which decides whether SKIP LOCKED skips in
 * queue order or in scan order).
 */
const CLAIM_JOIN = `
update conversations c0
   set owner_worker_id = $1,
       owner_until     = now() + ($2::bigint * interval '1 millisecond'),
       epoch           = c0.epoch + 1
 where (c0.user_id, c0.conversation_id) = (
         select c.user_id, c.conversation_id
           from conversations c
           join runs r using (user_id, conversation_id)
          where r.status = 'queued'
            and (c.owner_until is null or c.owner_until <= now())
          order by r.created_at
            for update of c skip locked
          limit 1)
returning c0.user_id, c0.conversation_id, c0.epoch, c0.owner_until`;

/** Fallback shape: take the row lock in its own statement, then update by key.
 * Two statements, same transaction — strictly more portable, one more round trip. */
const CLAIM_SELECT = `
  select c.user_id, c.conversation_id
    from conversations c
    join runs r using (user_id, conversation_id)
   where r.status = 'queued'
     and (c.owner_until is null or c.owner_until <= now())
   order by r.created_at
     for update of c skip locked
   limit 1`;

const CLAIM_UPDATE_BY_KEY = `
update conversations
   set owner_worker_id = $1,
       owner_until     = now() + ($2::bigint * interval '1 millisecond'),
       epoch           = epoch + 1
 where user_id = $3 and conversation_id = $4
returning user_id, conversation_id, epoch, owner_until`;

/**
 * Third shape: never join, so the candidate scan cannot produce duplicate
 * conversation rows. Orders by the conversation's oldest queued run via a
 * correlated scalar subquery.
 */
const CLAIM_EXISTS_MIN = `
update conversations c0
   set owner_worker_id = $1,
       owner_until     = now() + ($2::bigint * interval '1 millisecond'),
       epoch           = c0.epoch + 1
 where (c0.user_id, c0.conversation_id) = (
         select c.user_id, c.conversation_id
           from conversations c
          where (c.owner_until is null or c.owner_until <= now())
            and exists (select 1 from runs r
                         where r.user_id = c.user_id
                           and r.conversation_id = c.conversation_id
                           and r.status = 'queued')
          order by (select min(r.created_at) from runs r
                     where r.user_id = c.user_id
                       and r.conversation_id = c.conversation_id
                       and r.status = 'queued')
            for update skip locked
          limit 1)
returning c0.user_id, c0.conversation_id, c0.epoch, c0.owner_until`;

export function claimSql(shape: ClaimShape): string {
	if (shape === "join") return CLAIM_JOIN;
	if (shape === "exists_min") return CLAIM_EXISTS_MIN;
	return CLAIM_SELECT;
}

interface ClaimRow {
	user_id: string;
	conversation_id: string;
	epoch: number;
	owner_until: Date;
}

/** Take the Ownership lease on one claimable Conversation. Must run inside a
 * transaction: the lease write and the snapshot below share its commit. */
export async function claimConversation(
	tx: Queryable,
	input: { workerId: string; leaseMs: number; shape: ClaimShape },
): Promise<Claim | null> {
	if (input.shape === "select_then_update") {
		const candidate = await tx.query<{
			user_id: string;
			conversation_id: string;
		}>(CLAIM_SELECT);
		const row = candidate.rows[0];
		if (!row) return null;
		const updated = await tx.query<ClaimRow>(CLAIM_UPDATE_BY_KEY, [
			input.workerId,
			input.leaseMs,
			row.user_id,
			row.conversation_id,
		]);
		return updated.rows[0] ? toClaim(updated.rows[0]) : null;
	}
	const claimed = await tx.query<ClaimRow>(claimSql(input.shape), [
		input.workerId,
		input.leaseMs,
	]);
	return claimed.rows[0] ? toClaim(claimed.rows[0]) : null;
}

function toClaim(row: ClaimRow): Claim {
	return {
		userId: row.user_id,
		conversationId: row.conversation_id,
		epoch: Number(row.epoch),
		ownerUntil: row.owner_until,
	};
}

// ---------------------------------------------------------------------------
// Snapshot drain — the part §3.2 is about.
// ---------------------------------------------------------------------------

/**
 * The Runs this Claim will serve. Run in the SAME transaction as
 * {@link claimConversation}: the claim's UPDATE holds the `conversations` row
 * lock, and admission takes that same row `FOR UPDATE` before inserting, so an
 * admission either committed before the lock (inside the snapshot) or waits for
 * it (deferred to the next Claim). That is the whole load-bearing argument.
 */
export async function snapshotRuns(
	tx: Queryable,
	ref: ConversationRef,
): Promise<RunRef[]> {
	const { rows } = await tx.query<{ run_id: string; created_at: Date }>(
		`select run_id, created_at
		   from runs
		  where user_id = $1 and conversation_id = $2 and status = 'queued'
		  order by created_at, run_id`,
		[ref.userId, ref.conversationId],
	);
	return rows.map((r) => ({ runId: r.run_id, createdAt: r.created_at }));
}

/** Unconditional release — no "zero rows means work arrived, keep the lease"
 * subtlety, because snapshot drain already deferred mid-drain arrivals. */
export async function releaseConversation(
	q: Queryable,
	claim: Claim,
): Promise<boolean> {
	const { rowCount } = await q.query(
		`update conversations
		    set owner_worker_id = null, owner_until = null
		  where user_id = $1 and conversation_id = $2 and epoch = $3`,
		[claim.userId, claim.conversationId, claim.epoch],
	);
	return (rowCount ?? 0) > 0;
}

export async function renewLease(
	q: Queryable,
	claim: Claim,
	leaseMs: number,
): Promise<Date | null> {
	const { rows } = await q.query<{ owner_until: Date }>(
		`update conversations
		    set owner_until = now() + ($4::bigint * interval '1 millisecond')
		  where user_id = $1 and conversation_id = $2 and epoch = $3
		returning owner_until`,
		[claim.userId, claim.conversationId, claim.epoch, leaseMs],
	);
	return rows[0]?.owner_until ?? null;
}

// ---------------------------------------------------------------------------
// The fence — the probe §3.3 measures.
// ---------------------------------------------------------------------------

/** `EXISTS` probe on the `conversations` primary key. Takes no lock, so fence
 * reads never conflict with each other — only with Claim and release. */
const FENCE_EXISTS = `exists (
	select 1 from conversations c
	 where c.user_id = r.user_id
	   and c.conversation_id = r.conversation_id
	   and c.epoch = $2
	   and c.owner_until > now())`;

/** Today's shape, kept for the §3.3 A/B: the fence lives on the `runs` row
 * itself, so there is no `conversations` probe at all. */
const FENCE_RUN_LEASE = `r.locked_by = $2 and r.locked_until > now()`;

export type FenceKind = "conversation_epoch" | "run_lease";

function fencePredicate(kind: FenceKind): string {
	return kind === "conversation_epoch" ? FENCE_EXISTS : FENCE_RUN_LEASE;
}

/**
 * The representative fenced write: allocate the next event sequence number on
 * the Run under the fence, exactly as `appendRunEventsTx` does today (fence
 * rides the counter increment, so a stale worker cannot allocate a seq at all).
 * ~15–20 of these per turn.
 */
export async function fencedAppend(
	q: Queryable,
	input: {
		runId: string;
		fenceValue: number | string;
		fenceKind?: FenceKind;
	},
): Promise<FenceOutcome<{ seq: number }>> {
	const kind = input.fenceKind ?? "conversation_epoch";
	const { rows } = await q.query<{ seq: string }>(
		`update runs r
		    set next_event_seq = r.next_event_seq + 1, updated_at = now()
		  where r.run_id = $1
		    and r.status in ('running', 'interrupt_requested')
		    and ${fencePredicate(kind)}
		returning r.next_event_seq - 1 as seq`,
		[input.runId, input.fenceValue],
	);
	const row = rows[0];
	if (row) return { ok: true, value: { seq: Number(row.seq) } };
	return await classifyRejection(q, input.runId, input.fenceValue, kind);
}

/** Start serving a Run from the snapshot, under the same fence.
 * `alsoSetRunLease` populates today's `locked_by`/`locked_until` too, purely so
 * the §3.3 A/B can measure the old fence predicate against the new one. */
export async function startRun(
	q: Queryable,
	input: {
		runId: string;
		workerId: string;
		epoch: number;
		alsoSetRunLease?: boolean;
	},
): Promise<FenceOutcome<{ runId: string }>> {
	const { rows } = await q.query<{ run_id: string }>(
		`update runs r
		    set status = 'running',
		        executed_by_worker_id = $3,
		        updated_at = now()${
							input.alsoSetRunLease
								? `,
		        locked_by = $3,
		        locked_until = now() + interval '60 seconds'`
								: ""
						}
		  where r.run_id = $1
		    and r.status = 'queued'
		    and ${FENCE_EXISTS}
		returning r.run_id`,
		[input.runId, input.epoch, input.workerId],
	);
	const row = rows[0];
	if (row) return { ok: true, value: { runId: row.run_id } };
	return await classifyRejection(
		q,
		input.runId,
		input.epoch,
		"conversation_epoch",
	);
}

export async function terminalizeRun(
	q: Queryable,
	input: {
		runId: string;
		epoch: number;
		status: "done" | "error" | "interrupted";
	},
): Promise<FenceOutcome<{ status: string }>> {
	const { rows } = await q.query<{ status: string }>(
		`update runs r
		    set status = $3, terminal_at = now(), updated_at = now()
		  where r.run_id = $1
		    and r.status in ('running', 'interrupt_requested')
		    and ${FENCE_EXISTS}
		returning r.status`,
		[input.runId, input.epoch, input.status],
	);
	const row = rows[0];
	if (row) return { ok: true, value: { status: row.status } };
	return await classifyRejection(
		q,
		input.runId,
		input.epoch,
		"conversation_epoch",
	);
}

/** One classify read, same transaction, only on the zero-row path. */
async function classifyRejection<T>(
	q: Queryable,
	runId: string,
	fenceValue: number | string,
	kind: FenceKind,
): Promise<FenceOutcome<T>> {
	const { rows } = await q.query<{
		status: string;
		epoch: number | null;
		owner_until: Date | null;
		locked_by: string | null;
		locked_until: Date | null;
	}>(
		`select r.status, c.epoch, c.owner_until, r.locked_by, r.locked_until
		   from runs r
		   left join conversations c
		     on c.user_id = r.user_id and c.conversation_id = r.conversation_id
		  where r.run_id = $1`,
		[runId],
	);
	const row = rows[0];
	if (!row) return { ok: false, rejected: "gone" };
	const now = Date.now();
	const leaseLost =
		kind === "conversation_epoch"
			? Number(row.epoch) !== Number(fenceValue) ||
				!row.owner_until ||
				row.owner_until.getTime() <= now
			: row.locked_by !== fenceValue ||
				!row.locked_until ||
				row.locked_until.getTime() <= now;
	if (leaseLost) {
		return {
			ok: false,
			rejected: "lease",
			epoch: row.epoch === null ? null : Number(row.epoch),
			ownerUntil: row.owner_until,
		};
	}
	return { ok: false, rejected: "status", current: row.status };
}

// ---------------------------------------------------------------------------
// The adversary: admission, exactly as chat-api performs it today.
// ---------------------------------------------------------------------------

/**
 * `conversations FOR UPDATE` -> INSERT `runs` -> touch lifecycle metadata, in one
 * transaction. The lock order (conversations first) is what makes snapshot
 * integrity work; it is also why a Claim racing a busy admitter SKIP LOCKEDs
 * straight past the conversation.
 */
export async function admitRun(
	tx: Queryable,
	input: {
		userId: string;
		conversationId: string;
		runId: string;
		message: string;
	},
): Promise<"created" | "not_found"> {
	const locked = await tx.query(
		`select user_id from conversations
		  where user_id = $1 and conversation_id = $2 for update`,
		[input.userId, input.conversationId],
	);
	if (locked.rows.length === 0) return "not_found";
	await tx.query(
		`insert into runs (run_id, user_id, conversation_id, status, next_event_seq)
		 values ($1, $2, $3, 'queued', 2)
		 on conflict (run_id) do nothing`,
		[input.runId, input.userId, input.conversationId],
	);
	await tx.query(
		`update conversations
		    set title = coalesce(title, $3), last_activity_at = now()
		  where user_id = $1 and conversation_id = $2`,
		[input.userId, input.conversationId, input.message],
	);
	return "created";
}
