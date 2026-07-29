import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import {
	CANONICAL_MODEL_RUN_EVENT_TYPES,
	InvalidRunEventError,
	parseDurableRunEvent,
	RunEventType,
	type RunScope,
	validateDurableRunEventSequence,
} from "./run-events";
import {
	RunFenceError,
	runLeaseByUserConditions,
	type UserRunMutationOwner,
} from "./run-ownership";
import {
	publishAgentSessionPointerInTx,
	taintRecoveredRuntimeSandboxInTx,
} from "./runtime-store";
import { runEvents, runs } from "./schema";

/**
 * Narrow transaction helpers over `runs`/`run_events` — the only write path for
 * Run state — plus Agent-session pointer publication composed into terminal Run
 * transactions (design doc "State Ownership"). Shared by chat-api (run
 * creation, interruption requests) and agent-worker
 * (claim/heartbeat/terminalize). Each helper owns one transaction: sequence
 * allocation is database-owned (`runs.next_event_seq`, never app-side
 * `max(seq) + 1`), and every status change or append carries its fence either
 * inside the statement that performs it or, where a transaction composes
 * several writes, in a `FOR UPDATE` lock taken before the first of them — so
 * app-side select/update races cannot happen through this module. The fence
 * these writes evaluate is still the Run lease (`locked_by` + `locked_until`),
 * which carries no fencing token because a v1 run is claimed exactly once
 * (failed runs never requeue; stale runs are terminalized, never reclaimed).
 * Conversation-level ownership (ADR-0015) breaks that premise deliberately — a
 * Conversation is Claimed many times — which is why the epoch it introduces is
 * a necessary token rather than a redundant one, and why these writes move onto
 * it.
 */

/** All legal `runs.status` values (mirrors the DB check constraint). */
export type RunStatus =
	| "queued"
	| "running"
	| "interrupt_requested"
	| "done"
	| "error"
	| "interrupted";

/** The first admitted AG-UI input profile. Only client-authoritative fields
 * survive normalization; Scope and execution configuration remain server-owned. */
export interface NormalizedRunInputV1 {
	version: 1;
	messageId: string;
	text: string;
}

export type NormalizedRunInput = NormalizedRunInputV1;

/** A persisted run row. `status` is narrowed from text: rows are only ever
 * written through these helpers, which accept the typed union. */
export type RunRecord = Omit<
	typeof runs.$inferSelect,
	"normalizedInput" | "status"
> & {
	normalizedInput: NormalizedRunInput | null;
	status: RunStatus;
};

/** A stale Run after terminal recovery, plus whether that transaction created
 * its null-to-time Live Stream failure marker. */
export type RecoveredRunRecord = RunRecord & {
	liveStreamFailureMarkedByRecovery: boolean;
};

/**
 * Queue admission failed: the conversation already has an active
 * (queued/running/interrupt_requested) run. Surfaced as busy/backpressure by
 * the caller; the partial unique index is the authority.
 */
export class ActiveRunConflictError extends Error {
	override name = "ActiveRunConflictError";
}

/** An owned Run id was reused with different normalized admitted input. */
export class RunInputMismatchError extends Error {
	override name = "RunInputMismatchError" as const;
}

/** JSON body persisted with a run event. */
export type RunEventPayload = Record<string, unknown>;

/**
 * The two owned append classes (design doc "State Ownership"): `model` is
 * normal SDK content — assistant text, tool results — and is only legal while
 * the run is `running`; `cancellation` is the bounded command/process-kill
 * cleanup and audit trail the owning worker may still write after
 * `interrupt_requested` (the class keeps its internal process-cancellation
 * name per ADR-0013 — user-facing Run control is "interruption"). Terminal
 * events are deliberately not an append class here — they only exist through
 * the terminal transition helpers.
 */
export type RunEventAppendClass = "model" | "cancellation";

const APPEND_CLASS_STATUSES: Record<RunEventAppendClass, RunStatus[]> = {
	model: ["running"],
	cancellation: ["running", "interrupt_requested"],
};

/** The three terminal statuses a worker can transition an owned run into. */
export type TerminalRunStatus = "done" | "error" | "interrupted";

/** The helper owns the status→event-type mapping so a terminal run can never
 * carry a mismatched terminal event. Types come from the shared vocabulary so
 * the projector reads exactly what the terminal transition writes. */
const TERMINAL_EVENT_TYPES: Record<TerminalRunStatus, string> = {
	done: RunEventType.Done,
	error: RunEventType.Error,
	interrupted: RunEventType.Interrupted,
};

/** `done` must lose to a recorded interruption request, and `error` must not
 * overload user-directed interruption (an SDK failure after the interrupt
 * still surfaces as `interrupted`), so both are only legal from `running`;
 * only `interrupted` also closes an `interrupt_requested` run. */
const TERMINAL_FROM_STATUSES: Record<TerminalRunStatus, RunStatus[]> = {
	done: ["running"],
	error: ["running"],
	interrupted: ["running", "interrupt_requested"],
};

export interface AdmitQueuedRunInput {
	runId: string;
	userId: string;
	conversationId: string;
	messageId: string;
	text: string;
	scope: RunScope;
	collectionId: string | null;
	summaryId: string | null;
}

export type RunAdmissionResult =
	| { outcome: "created" | "existing"; run: RunRecord }
	| { outcome: "not_found" };

/**
 * Atomically admit the canonical client Run id and submitted User message.
 * The insert arbitrates on `run_id` alone, so the two admission conflicts stay
 * distinguishable at the database: a repeated Run id is absorbed by the arbiter
 * and classified by the ownership-scoped read below, while a *different* active
 * Run in the conversation violates `runs_one_active_per_conversation` and
 * raises a real unique violation, mapped here to backpressure. Re-admitting the
 * conversation's own active Run conflicts on both — Postgres checks the arbiter
 * index before the speculative insert, so the retry reattaches rather than
 * colliding with itself.
 *
 * That violation also aborts the enclosing transaction, so
 * {@link ActiveRunConflictError} must propagate out of it: a composer may catch
 * it to shape its own error, never to keep issuing statements.
 */
export async function admitQueuedRunTx(
	db: Database,
	input: AdmitQueuedRunInput,
): Promise<RunAdmissionResult> {
	return await db.transaction((tx) => admitQueuedRunInTx(tx, input));
}

/** Transaction-scoped form used when Conversation lifecycle locking and Run
 * admission must share one commit boundary. */
export async function admitQueuedRunInTx(
	tx: DbTx,
	input: AdmitQueuedRunInput,
): Promise<RunAdmissionResult> {
	const normalizedInput: NormalizedRunInput = {
		version: 1,
		messageId: input.messageId,
		text: input.text,
	};
	const startedPayload = {
		runId: input.runId,
		conversationId: input.conversationId,
		messageId: input.messageId,
		message: input.text,
		scope: input.scope,
		collectionId: input.collectionId,
		summaryId: input.summaryId,
	};
	parseDurableRunEvent(RunEventType.Started, startedPayload);

	let inserted: typeof runs.$inferSelect | undefined;
	try {
		[inserted] = await tx
			.insert(runs)
			.values({
				runId: input.runId,
				userId: input.userId,
				conversationId: input.conversationId,
				normalizedInput,
				status: "queued",
				nextEventSeq: 2,
			})
			.onConflictDoNothing({ target: runs.runId })
			.returning();
	} catch (error) {
		// `runs` carries exactly two unique constraints, and the arbiter already
		// absorbs the primary key, so a unique violation from this statement can
		// only be `runs_one_active_per_conversation`.
		if (isUniqueViolation(error)) {
			throw new ActiveRunConflictError(
				`conversation ${input.conversationId} already has an active run`,
				{ cause: error },
			);
		}
		throw error;
	}

	if (inserted) {
		await tx.insert(runEvents).values({
			runId: input.runId,
			seq: 1,
			type: RunEventType.Started,
			payload: startedPayload,
		});
		return { outcome: "created", run: toRunRecord(inserted) };
	}

	const [existing] = await tx
		.select()
		.from(runs)
		.where(eq(runs.runId, input.runId))
		.limit(1);
	if (!existing) {
		// The arbiter absorbed a `run_id` conflict, so the row existed a statement
		// ago; only a concurrent delete of the whole Conversation can get here.
		throw new Error(
			`run ${input.runId} conflicted on admission but vanished before it could be read`,
		);
	}
	if (
		existing.userId !== input.userId ||
		existing.conversationId !== input.conversationId
	) {
		return { outcome: "not_found" };
	}
	if (!normalizedInputsEqual(existing.normalizedInput, normalizedInput)) {
		throw new RunInputMismatchError(
			`run ${input.runId} was already admitted with different input`,
		);
	}
	return { outcome: "existing", run: toRunRecord(existing) };
}

function normalizedInputsEqual(
	stored: unknown,
	expected: NormalizedRunInput,
): boolean {
	return (
		typeof stored === "object" &&
		stored !== null &&
		"version" in stored &&
		stored.version === expected.version &&
		"messageId" in stored &&
		stored.messageId === expected.messageId &&
		"text" in stored &&
		stored.text === expected.text &&
		Object.keys(stored).length === 3
	);
}

/**
 * What a run's `run_started` event recorded about the turn: the user message
 * (the query prompt) and the conversation's frozen scope columns, exactly as
 * chat-api's admission transaction wrote them. The scope stays in row form
 * here — the worker parses it into its typed scope (fail-closed) at the edge
 * where document access is built.
 */
export interface RunStartedEvent {
	message: string;
	scope: string;
	collectionId: string | null;
	summaryId: string | null;
}

/**
 * Load the run's `run_started` event — the durable record of what the user
 * asked for (design: the worker reads the turn from the log, never from a
 * request body). Throws when the event is missing or its payload carries no
 * string message/scope: a run that cannot say what was asked must fail, not
 * run an empty prompt.
 */
export async function loadRunStartedTx(
	db: Database,
	input: { runId: string },
): Promise<RunStartedEvent> {
	const [row] = await db
		.select({ payload: runEvents.payload })
		.from(runEvents)
		.where(
			and(
				eq(runEvents.runId, input.runId),
				eq(runEvents.type, RunEventType.Started),
			),
		)
		.orderBy(runEvents.seq)
		.limit(1);
	if (!row) {
		throw new Error(`run ${input.runId} has no run_started event`);
	}
	const payload = row.payload as Record<string, unknown>;
	const { message, scope, collectionId, summaryId } = payload;
	if (typeof message !== "string" || typeof scope !== "string") {
		throw new Error(
			`run ${input.runId} has a malformed run_started payload: message/scope missing`,
		);
	}
	return {
		message,
		scope,
		collectionId: typeof collectionId === "string" ? collectionId : null,
		summaryId: typeof summaryId === "string" ? summaryId : null,
	};
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
				eq(
					runs.runId,
					sql`(
					select candidate.run_id from runs as candidate
					where candidate.status = 'queued'
					order by candidate.created_at
					for update skip locked
					limit 1
				)`,
				),
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
	const [appended] = await appendRunEventsTx(db, {
		runId: input.runId,
		workerId: input.workerId,
		appendClass: input.appendClass,
		events: [{ type: input.type, payload: input.payload }],
	});
	if (!appended)
		throw new Error("single Run-event append returned no sequence");
	return appended;
}

/**
 * Append a non-empty ordered batch under one Run-row fence and transaction.
 * A complete Tool invocation uses this so start/arguments/completion can never
 * be split by interruption, ownership loss, or a database failure.
 */
export async function appendRunEventsTx(
	db: Database,
	input: {
		runId: string;
		workerId: string;
		events: readonly { type: string; payload: RunEventPayload }[];
		appendClass: RunEventAppendClass;
	},
): Promise<Array<{ seq: number }>> {
	if (input.events.length === 0) {
		throw new Error("Run-event append batch must not be empty");
	}
	return await db.transaction(async (tx) => {
		const [allocated] = await tx
			.update(runs)
			.set({
				nextEventSeq: sql`${runs.nextEventSeq} + ${input.events.length}`,
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
			.returning({ nextEventSeq: runs.nextEventSeq });
		if (!allocated) {
			throw new RunFenceError(
				`${input.appendClass} append to run ${input.runId} rejected: ` +
					`run is not in an appendable status or worker ${input.workerId} no longer owns it`,
			);
		}
		for (const event of input.events) {
			const durableEvent = parseDurableRunEvent(event.type, event.payload);
			if (
				durableEvent &&
				(durableEvent.type === RunEventType.Started ||
					durableEvent.type === RunEventType.Done ||
					durableEvent.type === RunEventType.Error ||
					durableEvent.type === RunEventType.Interrupted)
			) {
				throw new InvalidRunEventError(
					`${event.type} cannot be written through the model append path`,
				);
			}
		}
		const canonicalEvents = input.events.filter((event) =>
			(CANONICAL_MODEL_RUN_EVENT_TYPES as readonly string[]).includes(
				event.type,
			),
		);
		if (canonicalEvents.length > 0) {
			const priorCanonicalEvents = await tx
				.select({ type: runEvents.type, payload: runEvents.payload })
				.from(runEvents)
				.where(
					and(
						eq(runEvents.runId, input.runId),
						inArray(runEvents.type, [
							RunEventType.Started,
							...CANONICAL_MODEL_RUN_EVENT_TYPES,
						]),
					),
				)
				.orderBy(runEvents.seq);
			validateDurableRunEventSequence(
				[...priorCanonicalEvents, ...canonicalEvents],
				{ allowIncomplete: true },
			);
		}
		const firstSeq = allocated.nextEventSeq - input.events.length;
		const appended = input.events.map((event, index) => ({
			runId: input.runId,
			seq: firstSeq + index,
			type: event.type,
			payload: event.payload,
		}));
		await tx.insert(runEvents).values(appended);
		return appended.map(({ seq }) => ({ seq }));
	});
}

/**
 * Move an owned run to a terminal status and append its one terminal event —
 * the fence, optional Agent-session pointer publication, the status CAS,
 * ownership clear (`locked_by`/`locked_until` → NULL), `terminal_at`, sequence
 * allocation, and event insert are one transaction.
 * The fence makes double-terminalization impossible (the second caller finds
 * the Run already terminal and is rejected), which is what makes "exactly one
 * terminal event per run" hold. Only the worker holding live ownership may
 * terminalize its run.
 *
 * A refused fence is a {@link TerminalTransitionResult}, not an exception:
 * losing to a durable interruption is an ordinary outcome the caller resolves,
 * and the rejection says whether the lease is gone (stop — recovery owns the
 * Run) or the status simply moved on (and to what). Genuine failures still
 * throw.
 */
export async function transitionRunTerminalTx(
	db: Database,
	input: TerminalTransitionInput,
): Promise<TerminalTransitionResult> {
	return await db.transaction((tx) => transitionRunTerminalInTx(tx, input));
}

interface TerminalOutcomeBase {
	payload?: RunEventPayload;
}

export type TerminalOutcome =
	| (TerminalOutcomeBase & {
			status: "done" | "interrupted";
			/** A session proven usable by a successful main-transcript mirror. When
			 * present, pointer publication and the terminal Outcome are all-or-nothing. */
			agentSessionId?: string;
	  })
	| (TerminalOutcomeBase & {
			status: "error";
			agentSessionId?: never;
	  });

export type TerminalTransitionInput = TerminalOutcome & {
	owner: UserRunMutationOwner;
};

/**
 * Why a fenced write was refused. `lease`: the caller no longer holds live
 * ownership — expired, reclaimed by recovery, or the Run/Conversation/user
 * identity does not match — so it must stop treating the Run as its own.
 * `status`: ownership is still live, but the Run's current status does not
 * permit the requested transition (`done` after an interruption was requested,
 * or a Run already terminalized); `current` says what the Run is actually in,
 * which is what lets the caller pick its one legal follow-up instead of
 * guessing. `gone`: the Run no longer exists, which means its Conversation was
 * permanently deleted and took the Run with it — there is nothing left to
 * terminalize, recover, or hand back.
 *
 * This is the fence vocabulary. The writes that still throw an opaque
 * {@link RunFenceError} classify into it as they adopt a typed rejection; none
 * of them grows a parallel shape of its own.
 */
export type FenceRejection =
	| { rejected: "lease" }
	| { rejected: "status"; current: RunStatus }
	| { rejected: "gone" };

export type TerminalTransitionResult =
	| { outcome: "committed"; run: RunRecord }
	| ({ outcome: "rejected" } & FenceRejection);

/**
 * Take the terminal fence for `status` and hold it for the rest of the
 * transaction. Fence-first: the row lock keeps ownership and status stable, so
 * everything composed after this point either commits behind a fence that was
 * already proven or rolls back with it — correctness stops depending on a
 * final compare-and-set happening to throw. Returns `null` when the fence
 * holds, or the classified rejection (one extra read, same transaction).
 */
export async function lockRunForTerminalInTx(
	tx: DbTx,
	owner: UserRunMutationOwner,
	status: TerminalRunStatus,
): Promise<FenceRejection | null> {
	const [held] = await tx
		.select({ runId: runs.runId })
		.from(runs)
		.where(
			and(
				runLeaseByUserConditions(owner),
				inArray(runs.status, TERMINAL_FROM_STATUSES[status]),
			),
		)
		.for("update");
	if (held) return null;
	return await classifyRunFenceRejectionInTx(tx, owner);
}

/**
 * Name why a fenced write found no row. One read, in the rejecting transaction
 * and only on the zero-row path, so the happy path pays nothing for it.
 *
 * The Run row is read by id alone, then the fence is re-evaluated over it: no
 * row at all is a deleted Conversation (Runs cascade with it) rather than a
 * lost lease, and those tell the caller different things — one has nothing left
 * to act on, the other has a successor that does.
 *
 * The fence re-evaluated here is deliberately the one the refused write itself
 * evaluated, which is still the Run lease. It moves to the Conversation
 * Ownership epoch in the same change that moves the fenced writes, not before:
 * a Conversation holds no live Ownership lease until something Claims it, so
 * re-pointing this read alone would report every status refusal as a lost lease.
 */
async function classifyRunFenceRejectionInTx(
	tx: DbTx,
	owner: UserRunMutationOwner,
): Promise<FenceRejection> {
	const [currentRun] = await tx
		.select({
			status: runs.status,
			fenceHolds: sql<boolean>`coalesce((${runLeaseByUserConditions(owner)}), false)`,
		})
		.from(runs)
		.where(eq(runs.runId, owner.runId))
		.limit(1);
	if (!currentRun) return { rejected: "gone" };
	if (!currentRun.fenceHolds) return { rejected: "lease" };
	return { rejected: "status", current: currentRun.status as RunStatus };
}

/**
 * Transaction-scoped form of {@link transitionRunTerminalTx}. Callers compose
 * other terminal facts through it; artifact publication, for example, commits
 * current metadata, an optional Agent-session pointer, and `run_done` together.
 */
export async function transitionRunTerminalInTx(
	tx: DbTx,
	input: TerminalTransitionInput,
): Promise<TerminalTransitionResult> {
	const rejection = await lockRunForTerminalInTx(tx, input.owner, input.status);
	if (rejection) return { outcome: "rejected", ...rejection };
	return {
		outcome: "committed",
		run: await commitLockedRunTerminalInTx(tx, input),
	};
}

/**
 * Commit the terminal status, the ownership clear, and the one terminal event
 * for a Run whose fence this transaction already holds through
 * {@link lockRunForTerminalInTx}. Split out so a composer can write its own
 * terminal facts between the fence and the Outcome — artifact publication
 * swaps current metadata there — without the fence arriving late enough that
 * only a thrown rollback could undo them.
 */
export async function commitLockedRunTerminalInTx(
	tx: DbTx,
	input: TerminalTransitionInput,
): Promise<RunRecord> {
	if (input.payload?.reason === "stale_worker") {
		throw new InvalidRunEventError(
			"stale_worker is reserved for stale-Run recovery",
		);
	}
	if (input.agentSessionId !== undefined) {
		await publishAgentSessionPointerInTx(tx, input.owner, input.agentSessionId);
	}
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
				runLeaseByUserConditions(input.owner),
				inArray(runs.status, TERMINAL_FROM_STATUSES[input.status]),
			),
		)
		.returning();
	if (!row) {
		throw new RunFenceError(
			`terminal transition of run ${input.owner.runId} to ${input.status} ` +
				`ran without holding its fence`,
		);
	}
	await insertTerminalEvent(tx, row, input.status, input.payload ?? {});
	return toRunRecord(row);
}

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
	const type = TERMINAL_EVENT_TYPES[status];
	const terminalPayload = { ...payload, outcome: status };
	parseDurableRunEvent(type, terminalPayload);
	const sequenceTypes = [
		RunEventType.Started,
		...CANONICAL_MODEL_RUN_EVENT_TYPES,
	];
	const priorCanonicalEvents = await tx
		.select({ type: runEvents.type, payload: runEvents.payload })
		.from(runEvents)
		.where(
			and(
				eq(runEvents.runId, row.runId),
				inArray(runEvents.type, sequenceTypes),
			),
		)
		.orderBy(runEvents.seq);
	validateDurableRunEventSequence([
		...priorCanonicalEvents,
		{ type, payload: terminalPayload },
	]);
	await tx.insert(runEvents).values({
		runId: row.runId,
		seq: row.nextEventSeq - 1,
		type,
		payload: terminalPayload,
	});
}

/**
 * How an interruption request landed. `interrupted`: the run is terminal with
 * its `run_interrupted` event — either this request terminalized a still-
 * queued run directly, or the interruption already won and this is a safe
 * retry (ADR-0013 keeps both at `202 { status: "interrupted" }`, distinct
 * from a `done`/`error` terminal). `interrupt_requested`: the run is
 * executing; the owning worker keeps ownership and terminalizes after
 * stopping (repeat requests are idempotent no-ops). `already_terminal`: the
 * run already committed `done` or `error`, so interruption conflicts — `run`
 * carries the status the caller should report.
 */
export type RunInterruptionResult =
	| {
			outcome: "interrupted" | "interrupt_requested" | "already_terminal";
			run: RunRecord;
	  }
	| { outcome: "not_found" };

/**
 * Record a user interruption request for an owned run. The row is locked
 * (`FOR UPDATE`) for the whole decision, so the status branch cannot race a
 * concurrent claim, append, or terminal transition. `userId`/`conversationId`
 * scope the lookup to the owner — a foreign run is `not_found`, never a state
 * change.
 */
export async function requestRunInterruptionTx(
	db: Database,
	input: { runId: string; userId: string; conversationId: string },
): Promise<RunInterruptionResult> {
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
			// Never claimed, so there is no owner to hand the interruption to:
			// terminalize directly, with the same counter-allocated terminal event
			// a worker transition would produce.
			const [row] = await tx
				.update(runs)
				.set({
					status: "interrupted",
					nextEventSeq: sql`${runs.nextEventSeq} + 1`,
					interruptRequestedAt: sql`now()`,
					lockedBy: null,
					lockedUntil: null,
					terminalAt: sql`now()`,
					updatedAt: sql`now()`,
				})
				.where(and(eq(runs.runId, input.runId), eq(runs.status, "queued")))
				.returning();
			if (!row) throw new Error(`queued run ${input.runId} vanished mid-lock`);
			await insertTerminalEvent(tx, row, "interrupted", {});
			return { outcome: "interrupted", run: toRunRecord(row) };
		}

		if (run.status === "running") {
			const [row] = await tx
				.update(runs)
				.set({
					status: "interrupt_requested",
					interruptRequestedAt: sql`now()`,
					updatedAt: sql`now()`,
				})
				.where(and(eq(runs.runId, input.runId), eq(runs.status, "running")))
				.returning();
			if (!row) throw new Error(`running run ${input.runId} vanished mid-lock`);
			return { outcome: "interrupt_requested", run: toRunRecord(row) };
		}

		if (run.status === "interrupt_requested") {
			return { outcome: "interrupt_requested", run: toRunRecord(run) };
		}

		if (run.status === "interrupted") {
			// The interruption already won; a retried request stays a success
			// (ADR-0013), never the `done`/`error` conflict.
			return { outcome: "interrupted", run: toRunRecord(run) };
		}

		return { outcome: "already_terminal", run: toRunRecord(run) };
	});
}

/**
 * Renew the caller's ownership of an active run — push `locked_until` ahead —
 * and return the fresh row, so the worker's control loop both keeps the run
 * alive and observes `interrupt_requested` through this one call. Fenced like an
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
				inArray(runs.status, ["running", "interrupt_requested"]),
				eq(runs.lockedBy, input.workerId),
				sql`${runs.lockedUntil} > now()`,
			),
		)
		.returning();
	return row ? toRunRecord(row) : null;
}

export type MarkLiveStreamFailedResult =
	| { outcome: "marked" | "already_failed"; run: RunRecord }
	| { outcome: "fence_rejected" };

/**
 * Monotonically record that a Run's Live Stream is unusable without changing
 * its execution status. Active writes require the same live worker ownership
 * fence as model appends. Once terminalization has cleared ownership, the
 * immutable Run permits only the idempotent NULL-to-time marker write; this
 * lets a terminal Redis publication failure safely race the terminal commit.
 */
export async function markLiveStreamFailedTx(
	db: Database,
	input: { runId: string; workerId: string },
): Promise<MarkLiveStreamFailedResult> {
	return await db.transaction(async (tx) => {
		const [before] = await tx
			.select()
			.from(runs)
			.where(eq(runs.runId, input.runId))
			.for("update");
		if (!before) return { outcome: "fence_rejected" };

		const writeAllowed = or(
			and(
				inArray(runs.status, ["running", "interrupt_requested"]),
				eq(runs.lockedBy, input.workerId),
				sql`${runs.lockedUntil} > now()`,
			),
			and(
				inArray(runs.status, ["done", "error", "interrupted"]),
				isNull(runs.lockedBy),
				isNull(runs.lockedUntil),
			),
		);
		if (before.liveStreamFailedAt !== null) {
			const [authorized] = await tx
				.select()
				.from(runs)
				.where(and(eq(runs.runId, input.runId), writeAllowed))
				.limit(1);
			return authorized
				? { outcome: "already_failed", run: toRunRecord(authorized) }
				: { outcome: "fence_rejected" };
		}

		const [row] = await tx
			.update(runs)
			.set({
				liveStreamFailedAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(runs.runId, input.runId),
					isNull(runs.liveStreamFailedAt),
					writeAllowed,
				),
			)
			.returning();
		if (!row) return { outcome: "fence_rejected" };
		return {
			outcome: "marked",
			run: toRunRecord(row),
		};
	});
}

/**
 * Stale-run recovery: terminalize every active run that can no longer make
 * progress. Expired `interrupt_requested` becomes `interrupted` — the user's
 * accepted control, never reclassified as an error; expired `running`
 * and old unclaimed `queued` runs become `error` (a v1 run is never reclaimed).
 * Each run's status CAS and terminal event share the transaction, and candidates
 * are taken `FOR UPDATE SKIP LOCKED`, so concurrent recovery loops across the
 * fleet split the work instead of blocking, and a run can never be
 * double-terminalized.
 *
 * Recovering a claimed run also taints the conversation's sandbox in the same
 * transaction: the lost owner may be partitioned rather than dead (a Bash
 * command may run four times longer than the lock it stopped renewing), and E2B
 * offers no compare-and-set to evict it, so taint is the only place the next
 * turn can be stopped from reconnecting to a workspace someone else is still
 * writing. Deliberately unfenced — this path exists precisely because run
 * ownership is already gone. Returns the runs it recovered for logging and
 * Live Stream telemetry.
 */
export async function markStaleRunsTx(
	db: Database,
): Promise<RecoveredRunRecord[]> {
	return await db.transaction(async (tx) => {
		const stale = await tx
			.select({
				runId: runs.runId,
				userId: runs.userId,
				conversationId: runs.conversationId,
				status: runs.status,
				liveStreamFailedAt: runs.liveStreamFailedAt,
			})
			.from(runs)
			.where(
				sql`(
					${runs.status} in ('running', 'interrupt_requested')
					and ${runs.lockedUntil} <= now()
				) or (
					${runs.status} = 'queued'
					and ${runs.createdAt} <= now() - interval '${sql.raw(
						String(LOCK_DURATION_MS),
					)} milliseconds'
				)`,
			)
			.for("update", { skipLocked: true });

		const recovered: RecoveredRunRecord[] = [];
		for (const candidate of stale) {
			const status: TerminalRunStatus =
				candidate.status === "interrupt_requested" ? "interrupted" : "error";
			const [row] = await tx
				.update(runs)
				.set({
					status,
					nextEventSeq: sql`${runs.nextEventSeq} + 1`,
					...(candidate.status === "queued"
						? {}
						: {
								liveStreamFailedAt: sql`coalesce(${runs.liveStreamFailedAt}, now())`,
							}),
					lockedBy: null,
					lockedUntil: null,
					terminalAt: sql`now()`,
					updatedAt: sql`now()`,
				})
				.where(
					and(
						eq(runs.runId, candidate.runId),
						inArray(runs.status, ["queued", "running", "interrupt_requested"]),
					),
				)
				.returning();
			if (!row) continue;
			if (candidate.status !== "queued") {
				// Only a claimed run can have touched the workspace; an unclaimed
				// queued run ages out without ever reaching a sandbox.
				await taintRecoveredRuntimeSandboxInTx(tx, candidate);
			}
			// The stale_worker Outcome is the durable proof that an incomplete Tool
			// prefix came from a crashed owner, so both recovery and history accept it.
			await insertTerminalEvent(tx, row, status, {
				...(status === "error" ? { message: "Run failed" } : {}),
				reason: "stale_worker",
			});
			recovered.push({
				...toRunRecord(row),
				liveStreamFailureMarkedByRecovery:
					candidate.status !== "queued" &&
					candidate.liveStreamFailedAt === null,
			});
		}
		return recovered;
	});
}

/** Narrow a persisted row to a {@link RunRecord}: rows are only ever written
 * through these helpers, so the text `status` is a legal {@link RunStatus}. */
export function toRunRecord(row: typeof runs.$inferSelect): RunRecord {
	return {
		...row,
		normalizedInput: row.normalizedInput as NormalizedRunInput | null,
		status: row.status as RunStatus,
	};
}

/** Whether `error` or anything it wraps satisfies `match`. Callers classify by
 * walking the chain because both admission and its composers re-wrap. */
function inCauseChain(error: unknown, match: (e: Error) => boolean): boolean {
	for (
		let e: unknown = error;
		e instanceof Error;
		e = (e as { cause?: unknown }).cause
	) {
		if (match(e)) return true;
	}
	return false;
}

/** SQLSTATE 23505 (unique_violation), on `pg` and pglite alike. Both drivers
 * carry the code; nothing here reads a constraint name or an error message. */
function isUniqueViolation(error: unknown): boolean {
	return inCauseChain(error, (e) => (e as { code?: unknown }).code === "23505");
}

/**
 * True when the error chain represents active-Run backpressure. Admission is
 * the only place the `runs_one_active_per_conversation` violation can be
 * raised, and it converts it there, so this is a plain cause-chain walk for
 * callers that wrap admission in their own transaction.
 */
export function isActiveRunConflict(error: unknown): boolean {
	return inCauseChain(error, (e) => e instanceof ActiveRunConflictError);
}
