import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { runEvents, runs } from "@/db/schema";
import type { ConversationRecord } from "@/features/conversation-store";
import { RunEventType } from "@/features/run-events";

/**
 * Narrow transaction helpers over `runs`/`run_events` — the only write path
 * for run state (design doc "State Ownership"). Each helper owns one
 * transaction: sequence allocation is database-owned (`runs.next_event_seq`,
 * never app-side `max(seq) + 1`), and every status change or append is fenced
 * inside the same statement that performs it, so app-side select/update races
 * cannot happen through this module. The ownership fence for v1 is
 * `locked_by` + `locked_until` — no fencing token, because a run is claimed
 * exactly once (failed runs never requeue; stale runs are terminalized, never
 * reclaimed).
 */

/** All legal `runs.status` values (mirrors the DB check constraint). */
export type RunStatus =
	| "queued"
	| "running"
	| "cancel_requested"
	| "done"
	| "error"
	| "canceled";

/** A persisted run row. `status` is narrowed from text: rows are only ever
 * written through these helpers, which accept the typed union. */
export type RunRecord = Omit<typeof runs.$inferSelect, "status"> & {
	status: RunStatus;
};

/**
 * Queue admission failed: the conversation already has an active
 * (queued/running/cancel_requested) run. Surfaced as busy/backpressure by the
 * caller; the partial unique index is the authority.
 */
export class ActiveRunConflictError extends Error {
	override name = "ActiveRunConflictError";
}

export class ActiveRunExistsError extends ActiveRunConflictError {
	override name = "ActiveRunExistsError" as const;
	constructor(options?: ErrorOptions) {
		super("Conversation already has an active run", options);
	}
}

/**
 * An ownership/status fence rejected the write: the run is not in a status
 * the append class allows, is owned by another worker, or the caller's
 * `locked_until` deadline has passed. The caller must stop treating the run
 * as its own; recovery (or the actual owner) is in charge now.
 */
export class RunFenceError extends Error {
	override name = "RunFenceError" as const;
}

/** JSON body persisted with a run event. */
export type RunEventPayload = Record<string, unknown>;

export interface CreateQueuedRunInput {
	conversation: ConversationRecord;
	message: string;
}

export interface CreateQueuedRunResult {
	runId: string;
}

export interface RunEventRecord {
	runId: string;
	seq: number;
	type: string;
	payload: unknown;
}

export interface RunStore {
	createQueuedRun(input: CreateQueuedRunInput): Promise<CreateQueuedRunResult>;
	getRun(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunRecord | null>;
}

/**
 * The two owned append classes (design doc "State Ownership"): `model` is
 * normal SDK content — assistant text, tool results — and is only legal while
 * the run is `running`; `cancellation` is the bounded cleanup/audit trail the
 * owning worker may still write after `cancel_requested`. Terminal events are
 * deliberately not an append class here — they only exist through the
 * terminal transition helpers.
 */
export type RunEventAppendClass = "model" | "cancellation";

const APPEND_CLASS_STATUSES: Record<RunEventAppendClass, RunStatus[]> = {
	model: ["running"],
	cancellation: ["running", "cancel_requested"],
};

/** The three terminal statuses a worker can transition an owned run into. */
export type TerminalRunStatus = "done" | "error" | "canceled";

/** The helper owns the status→event-type mapping so a terminal run can never
 * carry a mismatched terminal event. */
const TERMINAL_EVENT_TYPES: Record<TerminalRunStatus, string> = {
	done: "run_done",
	error: "run_error",
	canceled: "run_canceled",
};

/** `done` must lose to a recorded cancellation request, and `error` must not
 * overload user-initiated cancellation (an SDK failure after the interrupt
 * still surfaces as `canceled`), so both are only legal from `running`; only
 * `canceled` also closes a `cancel_requested` run. */
const TERMINAL_FROM_STATUSES: Record<TerminalRunStatus, RunStatus[]> = {
	done: ["running"],
	error: ["running"],
	canceled: ["running", "cancel_requested"],
};

/**
 * Insert one `queued` run. The `runs_one_active_per_conversation` partial
 * unique index enforces single-admission at the DB layer; a violation is
 * mapped to {@link ActiveRunConflictError}. Any other failure (including a
 * duplicate `runId`) is rethrown untouched.
 */
export async function createQueuedRunTx(
	db: Database,
	input: { runId: string; userId: string; conversationId: string },
): Promise<RunRecord> {
	try {
		const [row] = await db
			.insert(runs)
			.values({
				runId: input.runId,
				userId: input.userId,
				conversationId: input.conversationId,
				status: "queued",
			})
			.returning();
		if (!row) throw new Error(`insert of run ${input.runId} returned no row`);
		return toRunRecord(row);
	} catch (error) {
		if (isActiveRunConflict(error)) {
			throw new ActiveRunConflictError(
				`conversation ${input.conversationId} already has an active run`,
				{ cause: error },
			);
		}
		throw error;
	}
}

export async function createQueuedRunStartedTx(
	db: Database,
	input: CreateQueuedRunInput & { runId: string },
): Promise<RunRecord> {
	const { conversation, message, runId } = input;
	try {
		return await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(runs)
				.values({
					runId,
					userId: conversation.userId,
					conversationId: conversation.conversationId,
					status: "queued",
					nextEventSeq: 2,
				})
				.returning();
			if (!row) throw new Error(`insert of run ${runId} returned no row`);
			await tx.insert(runEvents).values({
				runId,
				seq: 1,
				type: RunEventType.Started,
				payload: {
					userId: conversation.userId,
					conversationId: conversation.conversationId,
					runId,
					message,
					scope: conversation.scope,
					collectionId: conversation.collectionId,
					summaryId: conversation.summaryId,
				},
			});
			return toRunRecord(row);
		});
	} catch (error) {
		if (isActiveRunConflict(error)) {
			throw new ActiveRunExistsError({ cause: error });
		}
		throw error;
	}
}

export class PostgresRunStore implements RunStore {
	constructor(private readonly db: Database) {}

	async createQueuedRun(
		input: CreateQueuedRunInput,
	): Promise<CreateQueuedRunResult> {
		const runId = crypto.randomUUID();
		await createQueuedRunStartedTx(this.db, { ...input, runId });
		return { runId };
	}

	async getRun(input: {
		userId: string;
		conversationId: string;
		runId: string;
	}): Promise<RunRecord | null> {
		const rows = await this.db
			.select()
			.from(runs)
			.where(
				and(
					eq(runs.userId, input.userId),
					eq(runs.conversationId, input.conversationId),
					eq(runs.runId, input.runId),
				),
			)
			.limit(1);
		return rows[0] ? toRunRecord(rows[0]) : null;
	}

	async listRunEventsAfter(input: {
		runId: string;
		afterSeq: number;
	}): Promise<RunEventRecord[]> {
		return this.db
			.select({
				runId: runEvents.runId,
				seq: runEvents.seq,
				type: runEvents.type,
				payload: runEvents.payload,
			})
			.from(runEvents)
			.where(
				and(
					eq(runEvents.runId, input.runId),
					gt(runEvents.seq, input.afterSeq),
				),
			)
			.orderBy(runEvents.seq);
	}
}

/** How far ahead a claim/heartbeat pushes `locked_until` (design: 60s hold,
 * 15s heartbeat — four missed heartbeats before a run is recoverable). */
const LOCK_DURATION_MS = 60_000;

/**
 * Claim the oldest queued run for `workerId`, or return `null` when the queue
 * is empty. One atomic statement: the candidate select (`FOR UPDATE SKIP
 * LOCKED`, so concurrent claimants skip each other's candidate instead of
 * blocking or double-claiming), the `status = 'queued'` recheck, and the
 * ownership write all happen inside a single UPDATE — never a separate
 * app-side select followed by an update.
 */
export async function claimNextRunTx(
	db: Database,
	input: { workerId: string },
): Promise<RunRecord | null> {
	const [row] = await db
		.update(runs)
		.set({
			status: "running",
			lockedBy: input.workerId,
			lockedUntil: sql`now() + (${LOCK_DURATION_MS} * interval '1 millisecond')`,
			heartbeatAt: sql`now()`,
			updatedAt: sql`now()`,
		})
		.where(
			and(
				eq(runs.status, "queued"),
				sql`${runs.runId} in (
					select run_id from runs
					where status = 'queued'
					order by created_at
					for update skip locked
					limit 1
				)`,
			),
		)
		.returning();
	return row ? toRunRecord(row) : null;
}

/**
 * Append one owned run event, allocating `seq` from `runs.next_event_seq` and
 * inserting the event row in the same transaction — the counter update carries
 * the fence for the append class (status set, `locked_by = workerId`,
 * `locked_until > now()`), so a stale or non-owning worker cannot allocate a
 * sequence number at all. Throws {@link RunFenceError} when the fence rejects.
 */
export async function appendRunEventTx(
	db: Database,
	input: {
		runId: string;
		workerId: string;
		type: string;
		payload: RunEventPayload;
		appendClass: RunEventAppendClass;
	},
): Promise<{ seq: number }> {
	return await db.transaction(async (tx) => {
		const [allocated] = await tx
			.update(runs)
			.set({
				nextEventSeq: sql`${runs.nextEventSeq} + 1`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(runs.runId, input.runId),
					inArray(runs.status, APPEND_CLASS_STATUSES[input.appendClass]),
					eq(runs.lockedBy, input.workerId),
					sql`${runs.lockedUntil} > now()`,
				),
			)
			// In UPDATE ... RETURNING the column holds its new value, so the
			// pre-increment counter — this append's seq — is `next_event_seq - 1`.
			.returning({ seq: sql`${runs.nextEventSeq} - 1` });
		if (!allocated) {
			throw new RunFenceError(
				`${input.appendClass} append to run ${input.runId} rejected: ` +
					`run is not in an appendable status or worker ${input.workerId} no longer owns it`,
			);
		}
		const seq = Number(allocated.seq);
		await tx.insert(runEvents).values({
			runId: input.runId,
			seq,
			type: input.type,
			payload: input.payload,
		});
		return { seq };
	});
}

/**
 * Move an owned run to a terminal status and append its one terminal event —
 * the status CAS, ownership clear (`locked_by`/`locked_until` → NULL),
 * `terminal_at`, sequence allocation, and event insert are one transaction.
 * The from-status CAS makes double-terminalization impossible (the second
 * caller finds no row and gets {@link RunFenceError}), which is what makes
 * "exactly one terminal event per run" hold. Fenced like an owned append:
 * only the worker holding live ownership may terminalize its run.
 */
export async function transitionRunTerminalTx(
	db: Database,
	input: {
		runId: string;
		workerId: string;
		status: TerminalRunStatus;
		payload?: RunEventPayload;
	},
): Promise<RunRecord> {
	return await db.transaction(async (tx) => {
		const [row] = await tx
			.update(runs)
			.set({
				status: input.status,
				nextEventSeq: sql`${runs.nextEventSeq} + 1`,
				lockedBy: null,
				lockedUntil: null,
				terminalAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(runs.runId, input.runId),
					inArray(runs.status, TERMINAL_FROM_STATUSES[input.status]),
					eq(runs.lockedBy, input.workerId),
					sql`${runs.lockedUntil} > now()`,
				),
			)
			.returning();
		if (!row) {
			throw new RunFenceError(
				`terminal transition of run ${input.runId} to ${input.status} rejected: ` +
					`run is already terminal, not transitionable to ${input.status}, or worker ${input.workerId} no longer owns it`,
			);
		}
		await insertTerminalEvent(tx, row, input.status, input.payload ?? {});
		return toRunRecord(row);
	});
}

/** A Drizzle client scoped to one open transaction. */
type DbTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Insert the one terminal event for a run row a terminal CAS just returned —
 * that CAS already incremented `next_event_seq`, so the pre-increment value
 * (`nextEventSeq - 1`) is this event's seq.
 */
async function insertTerminalEvent(
	tx: DbTx,
	row: typeof runs.$inferSelect,
	status: TerminalRunStatus,
	payload: RunEventPayload,
): Promise<void> {
	await tx.insert(runEvents).values({
		runId: row.runId,
		seq: row.nextEventSeq - 1,
		type: TERMINAL_EVENT_TYPES[status],
		payload,
	});
}

/**
 * How a cancellation request landed. `canceled`: the run was still queued and
 * is now terminal with its `run_canceled` event. `cancel_requested`: the run
 * is executing; the owning worker keeps ownership and terminalizes after
 * interrupting (repeat requests are idempotent no-ops). `already_terminal`:
 * nothing to cancel — `run` carries the status the caller should report.
 */
export type RunCancellationResult =
	| {
			outcome: "canceled" | "cancel_requested" | "already_terminal";
			run: RunRecord;
	  }
	| { outcome: "not_found" };

/**
 * Record a user cancellation request for an owned run. The row is locked
 * (`FOR UPDATE`) for the whole decision, so the status branch cannot race a
 * concurrent claim, append, or terminal transition. `userId`/`conversationId`
 * scope the lookup to the owner — a foreign run is `not_found`, never a state
 * change.
 */
export async function requestRunCancellationTx(
	db: Database,
	input: { runId: string; userId: string; conversationId: string },
): Promise<RunCancellationResult> {
	return await db.transaction(async (tx) => {
		const [run] = await tx
			.select()
			.from(runs)
			.where(
				and(
					eq(runs.runId, input.runId),
					eq(runs.userId, input.userId),
					eq(runs.conversationId, input.conversationId),
				),
			)
			.for("update");
		if (!run) return { outcome: "not_found" };

		if (run.status === "queued") {
			// Never claimed, so there is no owner to hand the cancellation to:
			// terminalize directly, with the same counter-allocated terminal event
			// a worker transition would produce.
			const [row] = await tx
				.update(runs)
				.set({
					status: "canceled",
					nextEventSeq: sql`${runs.nextEventSeq} + 1`,
					cancelRequestedAt: sql`now()`,
					lockedBy: null,
					lockedUntil: null,
					terminalAt: sql`now()`,
					updatedAt: sql`now()`,
				})
				.where(and(eq(runs.runId, input.runId), eq(runs.status, "queued")))
				.returning();
			if (!row) throw new Error(`queued run ${input.runId} vanished mid-lock`);
			await insertTerminalEvent(tx, row, "canceled", {});
			return { outcome: "canceled", run: toRunRecord(row) };
		}

		if (run.status === "running") {
			const [row] = await tx
				.update(runs)
				.set({
					status: "cancel_requested",
					cancelRequestedAt: sql`now()`,
					updatedAt: sql`now()`,
				})
				.where(and(eq(runs.runId, input.runId), eq(runs.status, "running")))
				.returning();
			if (!row) throw new Error(`running run ${input.runId} vanished mid-lock`);
			return { outcome: "cancel_requested", run: toRunRecord(row) };
		}

		if (run.status === "cancel_requested") {
			return { outcome: "cancel_requested", run: toRunRecord(run) };
		}

		return { outcome: "already_terminal", run: toRunRecord(run) };
	});
}

/**
 * Renew the caller's ownership of an active run — push `locked_until` ahead —
 * and return the fresh row, so the worker's control loop both keeps the run
 * alive and observes `cancel_requested` through this one call. Fenced like an
 * append: active status, matching `locked_by`, and an unexpired
 * `locked_until`. Returns `null` when the fence rejects — expired ownership
 * is never revived (the run belongs to stale-run recovery now), and the
 * caller must abandon the run locally.
 */
export async function heartbeatRunTx(
	db: Database,
	input: { runId: string; workerId: string },
): Promise<RunRecord | null> {
	const [row] = await db
		.update(runs)
		.set({
			heartbeatAt: sql`now()`,
			lockedUntil: sql`now() + (${LOCK_DURATION_MS} * interval '1 millisecond')`,
			updatedAt: sql`now()`,
		})
		.where(
			and(
				eq(runs.runId, input.runId),
				inArray(runs.status, ["running", "cancel_requested"]),
				eq(runs.lockedBy, input.workerId),
				sql`${runs.lockedUntil} > now()`,
			),
		)
		.returning();
	return row ? toRunRecord(row) : null;
}

/**
 * Stale-run recovery: terminalize every active run that can no longer make
 * progress. Expired `cancel_requested` becomes `canceled`; expired `running`
 * and old unclaimed `queued` runs become `error` (a v1 run is never reclaimed).
 * Each run's status CAS and terminal event share the transaction, and candidates
 * are taken `FOR UPDATE SKIP LOCKED`, so concurrent recovery loops across the
 * fleet split the work instead of blocking, and a run can never be
 * double-terminalized. Returns the runs it recovered so the caller can clean up
 * their sandbox side effects.
 */
export async function markStaleRunsTx(db: Database): Promise<RunRecord[]> {
	return await db.transaction(async (tx) => {
		const stale = await tx
			.select({ runId: runs.runId, status: runs.status })
			.from(runs)
			.where(
				sql`(
					${runs.status} in ('running', 'cancel_requested')
					and ${runs.lockedUntil} <= now()
				) or (
					${runs.status} = 'queued'
					and ${runs.createdAt} <= now() - interval '${sql.raw(
						String(LOCK_DURATION_MS),
					)} milliseconds'
				)`,
			)
			.for("update", { skipLocked: true });

		const recovered: RunRecord[] = [];
		for (const candidate of stale) {
			const status: TerminalRunStatus =
				candidate.status === "cancel_requested" ? "canceled" : "error";
			const [row] = await tx
				.update(runs)
				.set({
					status,
					nextEventSeq: sql`${runs.nextEventSeq} + 1`,
					lockedBy: null,
					lockedUntil: null,
					terminalAt: sql`now()`,
					updatedAt: sql`now()`,
				})
				.where(
					and(
						eq(runs.runId, candidate.runId),
						inArray(runs.status, ["queued", "running", "cancel_requested"]),
					),
				)
				.returning();
			if (!row) continue;
			await insertTerminalEvent(tx, row, status, { reason: "stale_worker" });
			recovered.push(toRunRecord(row));
		}
		return recovered;
	});
}

function toRunRecord(row: typeof runs.$inferSelect): RunRecord {
	return { ...row, status: row.status as RunStatus };
}

/**
 * True when the error chain is a unique violation of the
 * `runs_one_active_per_conversation` partial index. Matched by constraint
 * name (node-postgres exposes `constraint`) with a message fallback (pglite
 * in tests), so a duplicate-`runId` primary-key violation stays distinct.
 */
function isActiveRunConflict(error: unknown): boolean {
	for (
		let e: unknown = error;
		e instanceof Error;
		e = (e as { cause?: unknown }).cause
	) {
		const constraint = (e as { constraint?: unknown }).constraint;
		if (constraint === "runs_one_active_per_conversation") return true;
		if (e.message.includes("runs_one_active_per_conversation")) return true;
	}
	return false;
}
