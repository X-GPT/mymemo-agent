import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import {
	type ConversationOwner,
	liveConversationOwnershipExists,
} from "./conversation-ownership";
import {
	AGENTCORE_EXECUTION_RUNTIME,
	FARGATE_EXECUTION_RUNTIME,
	requireConversationExecutionRuntime,
} from "./execution-runtime";
import {
	CANONICAL_MODEL_RUN_EVENT_TYPES,
	InvalidRunEventError,
	parseDurableRunEvent,
	RunEventType,
	type RunScope,
	validateDurableRunEventSequence,
} from "./run-events";
import {
	publishAgentSessionPointerInTx,
	taintRuntimeSandboxForReclamationInTx,
} from "./runtime-store";
import {
	ACTIVE_RUN_STATUSES,
	type ALL_RUN_STATUSES,
	conversations,
	runEvents,
	runs,
	TERMINAL_RUN_STATUSES,
} from "./schema";

/**
 * Narrow transaction helpers over `runs`/`run_events` — the only write path for
 * Run state — plus Agent-session pointer publication composed into terminal Run
 * transactions (design doc "State Ownership"). Shared by chat-api (run
 * creation and interruption requests) and agent-worker (start, append, and
 * terminalize). Each helper owns one transaction: sequence
 * allocation is database-owned (`runs.next_event_seq`, never app-side
 * `max(seq) + 1`), and every status change or append carries its fence either
 * inside the statement that performs it or, where a transaction composes
 * several writes, in a `FOR UPDATE` lock taken before the first of them — so
 * app-side select/update races cannot happen through this module.
 *
 * Run-state writes — start, event append, terminal transition, and the active
 * Live Stream failure marker — fence on the Conversation Ownership epoch
 * (ADR-0015). The epoch is necessary because a Conversation is Claimed many
 * times by different workers; worker identity alone cannot distinguish a stale
 * holder from a later Claim by the same process.
 */

/** All legal `runs.status` values. Derived from the same tuple `runs_status_check`
 * is built from, so "mirrors the DB check constraint" is true by construction
 * rather than by two lists being kept in step. */
export type RunStatus = (typeof ALL_RUN_STATUSES)[number];

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

/** A Run terminalized by Reclamation, plus whether that transaction created
 * its null-to-time Live Stream failure marker. */
export type ReclaimedRunRecord = RunRecord & {
	liveStreamFailureMarkedByReclamation: boolean;
};

/** One Conversation reclaimed in one transaction, including every Run that
 * reached an Outcome as part of that Reclamation. */
export interface ReclaimedConversation {
	userId: string;
	conversationId: string;
	runs: ReclaimedRunRecord[];
}

/** Old queued Runs expired from one unowned Conversation. This is the retained
 * queue-age backstop, not Reclamation: no Ownership lease was lost. */
export interface ExpiredQueuedRuns {
	userId: string;
	conversationId: string;
	runs: RunRecord[];
}

/**
 * Queue admission failed: the conversation already has an active
 * (queued/running/interrupt_requested) run. Surfaced as busy/backpressure by
 * the caller; {@link admitQueuedRunInTx}'s explicit bound check is the authority.
 */
export class ActiveRunConflictError extends Error {
	override name = "ActiveRunConflictError";
}

/**
 * How many Active Runs one Conversation may hold. Raising it is a product
 * decision, not a tuning knob: the Claim's candidate scan walks `runs` in
 * global submission order and probes `conversations` per row, so every queued
 * Run on an already-owned Conversation is a row every idle worker walks past on
 * every tick. This bound therefore bounds claim cost as much as drain length.
 */
const ACTIVE_RUN_DEPTH_BOUND = 1;

/** How long a queued Run may remain continuously eligible on an unowned
 * Conversation before the queue-age backstop ends it. Reclamation refreshes
 * `updated_at` to start a new window for legitimately waiting work. The
 * Fargate window deliberately matches today's 60-second Ownership lease,
 * but remains a distinct policy so lease tuning cannot silently retune queue
 * expiration. AgentCore work gets ten minutes for dispatch and cold
 * start. */
const FARGATE_UNOWNED_QUEUE_TIMEOUT_MS = 60_000;
export const AGENTCORE_UNOWNED_QUEUE_TIMEOUT_MS = 10 * 60_000;

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

/** One Run addressed through the Claim that owns its Conversation. The epoch
 * is the write authority. `workerId` is provenance for orphan-sandbox records,
 * never fence authority. */
export interface RunWriteOwner extends ConversationOwner {
	runId: string;
	workerId: string;
}

const APPEND_CLASS_STATUSES: Record<RunEventAppendClass, RunStatus[]> = {
	model: ["running"],
	cancellation: ["running", "interrupt_requested"],
};

/** The three terminal statuses a worker can transition an owned run into. */
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalRunStatus(
	status: string,
): status is TerminalRunStatus {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

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
 * Standalone form, for callers with no Conversation lifecycle transaction of
 * their own: it takes the Conversation row lock that {@link admitQueuedRunInTx}
 * expects its composer to hold, because that lock is what makes the Active Run
 * count authoritative. A Conversation that does not exist locks nothing, and
 * admission then resolves the input against `runs` alone as it always has.
 */
export async function admitQueuedRunTx(
	db: Database,
	input: AdmitQueuedRunInput,
): Promise<RunAdmissionResult> {
	return await db.transaction(async (tx) => {
		await tx
			.select({ conversationId: conversations.conversationId })
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, input.userId),
					eq(conversations.conversationId, input.conversationId),
				),
			)
			.for("update");
		return await admitQueuedRunInTx(tx, input);
	});
}

/**
 * Transaction-scoped form used when Conversation lifecycle locking and Run
 * admission must share one commit boundary. **The caller must already hold the
 * Conversation row `FOR UPDATE`** — that lock serializes concurrent admissions
 * for one Conversation, which is the whole reason the Active Run bound check
 * below is authoritative.
 *
 * The insert arbitrates on `run_id` alone, and that is now the only conflict it
 * can raise. It also runs *first*, which is what keeps an already-admitted Run
 * id resolving as an identity — reattach, input mismatch, or foreign — instead
 * of colliding with a bound that has nothing to do with it. A genuinely new Run
 * arriving at a Conversation already at its bound is refused after that insert,
 * so {@link ActiveRunConflictError} must propagate out of the transaction and
 * roll it back: a composer may catch it to shape its own error, never to keep
 * issuing statements.
 */
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

	const [inserted] = await tx
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

	if (!inserted) {
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

	// A genuinely new Run, so the bound applies. The row just inserted is excluded
	// from it; `interrupt_requested` counts with the rest of the Active set, since
	// a Run being interrupted has not finished and the next one waits for its
	// Outcome. `limit` rather than `count(*)`: the question is whether the bound
	// is already met, so there is nothing to gain by counting past it.
	const active = await tx
		.select({ runId: runs.runId })
		.from(runs)
		.where(
			and(
				eq(runs.userId, input.userId),
				eq(runs.conversationId, input.conversationId),
				ne(runs.runId, input.runId),
				// `satisfies` keeps the schema module's tuple honest against the
				// status union, which lives here: `runs.status` is a text column, so
				// nothing else in this statement would reject a typo.
				inArray(
					runs.status,
					ACTIVE_RUN_STATUSES satisfies readonly RunStatus[],
				),
			),
		)
		.limit(ACTIVE_RUN_DEPTH_BOUND);
	if (active.length >= ACTIVE_RUN_DEPTH_BOUND) {
		throw new ActiveRunConflictError(
			`conversation ${input.conversationId} already has an active run`,
		);
	}

	await tx.insert(runEvents).values({
		runId: input.runId,
		seq: 1,
		type: RunEventType.Started,
		payload: startedPayload,
	});
	return { outcome: "created", run: toRunRecord(inserted) };
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

/**
 * Why a fenced write was refused. `lease`: the caller no longer holds live
 * ownership — expired, taken by Reclamation, or the Run/Conversation/user
 * identity does not match — so it must stop treating the Run as its own.
 * `status`: ownership is still live, but the Run's current status does not
 * permit the requested transition (`done` after an interruption was requested,
 * or a Run already terminalized); `current` says what the Run is actually in,
 * which is what lets the caller pick its one legal follow-up instead of
 * guessing. `gone`: the Run no longer exists, which means its Conversation was
 * permanently deleted and took the Run with it — there is nothing left to
 * terminalize, recover, or hand back.
 *
 * This is the one fence vocabulary for every Run-state write; no operation
 * grows a parallel rejection shape of its own.
 */
export type FenceRejection =
	| { rejected: "lease" }
	| { rejected: "status"; current: RunStatus }
	| { rejected: "gone" };

/** Shared rejected arm returned by every fenced Run-state write. */
export type RunWriteRejected = { outcome: "rejected" } & FenceRejection;

export type StartClaimedRunResult =
	| { outcome: "started"; run: RunRecord }
	| RunWriteRejected;

/**
 * Serve one Run of a Claimed Conversation: `queued` → `running` under the
 * Ownership epoch fence, recording which worker executes it. This is the drain's
 * per-Run entry point — the Conversation, not the Run, is what was claimed, so
 * the authority here is the Claim's epoch and a live Ownership deadline.
 *
 * A refusal is a classified {@link FenceRejection} rather than an exception,
 * because the drain answers the three cases differently: `lease` — a successor
 * owns the Conversation, so halt and abandon without releasing; `status` — this
 * Run reached its Outcome underneath us (a queued Run interrupted between the
 * snapshot and here), so skip it and serve the next one; `gone` — the
 * Conversation was deleted and took its Runs with it, so stop.
 */
export async function startClaimedRunTx(
	db: Database,
	input: { owner: ConversationOwner; runId: string; workerId: string },
): Promise<StartClaimedRunResult> {
	return await db.transaction(async (tx) => {
		const [row] = await tx
			.update(runs)
			.set({
				status: "running",
				executedByWorkerId: input.workerId,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					claimedRunConditions(input.owner, input.runId),
					eq(runs.status, "queued"),
					liveConversationOwnershipExists(input.owner),
				),
			)
			.returning();
		if (row) return { outcome: "started", run: toRunRecord(row) };
		return {
			outcome: "rejected",
			...(await classifyStartRejectionInTx(tx, input.owner, input.runId)),
		};
	});
}

/**
 * Read the status of the Run currently served by a Conversation drain. This is
 * interruption observation only, not authority: every mutation still carries
 * the Conversation Ownership epoch fence. A missing row means the Run reached
 * an Outcome or its Conversation was deleted while the processor was active.
 */
export async function loadExecutingRunTx(
	db: Database,
	input: { userId: string; conversationId: string; runId: string },
): Promise<RunRecord | null> {
	const [row] = await db
		.select()
		.from(runs)
		.where(
			and(
				eq(runs.runId, input.runId),
				eq(runs.userId, input.userId),
				eq(runs.conversationId, input.conversationId),
				inArray(runs.status, ["running", "interrupt_requested"]),
			),
		)
		.limit(1);
	return row ? toRunRecord(row) : null;
}

/** The Run as a Claim addresses it: this Run, of this Claimed Conversation. The
 * Conversation scoping is what keeps one Claim's authority from reaching a Run
 * it never snapshotted. */
function claimedRunConditions(owner: ConversationOwner, runId: string) {
	return and(
		eq(runs.runId, runId),
		eq(runs.userId, owner.userId),
		eq(runs.conversationId, owner.conversationId),
	);
}

/**
 * Name why {@link startClaimedRunTx} found no row. The lookup carries the
 * write's Conversation scoping, so a Run outside the Claim is reported as `gone`
 * rather than distinguished. That is deliberate: only a Run of the Claim's own
 * snapshot can legitimately be asked about, and both readings tell the drain the
 * same thing — stop, there is nothing here to serve. Dropping the scoping to
 * tell them apart would be worse, because the epoch fence is on `conversations`
 * and would then hold for a foreign Run, reporting it as a skippable `status`
 * refusal.
 */
function classifyStartRejectionInTx(
	tx: DbTx,
	owner: ConversationOwner,
	runId: string,
): Promise<FenceRejection> {
	return classifyFenceRejectionInTx(
		tx,
		claimedRunConditions(owner, runId),
		liveConversationOwnershipExists(owner),
	);
}

/**
 * Append one owned run event, allocating `seq` from `runs.next_event_seq` and
 * inserting the event row in the same transaction — the counter update carries
 * the append status and Ownership epoch fence, so a superseded Claim cannot
 * allocate a sequence number at all. A refusal is classified through the same
 * {@link FenceRejection} vocabulary as every other fenced Run write.
 */
export async function appendRunEventTx(
	db: Database,
	input: {
		owner: RunWriteOwner;
		type: string;
		payload: RunEventPayload;
		appendClass: RunEventAppendClass;
	},
): Promise<AppendRunEventResult> {
	const result = await appendRunEventsTx(db, {
		owner: input.owner,
		appendClass: input.appendClass,
		events: [{ type: input.type, payload: input.payload }],
	});
	if (result.outcome === "rejected") return result;
	const [appended] = result.events;
	if (!appended)
		throw new Error("single Run-event append returned no sequence");
	return { outcome: "appended", seq: appended.seq };
}

export type AppendRunEventResult =
	| { outcome: "appended"; seq: number }
	| RunWriteRejected;

export type AppendRunEventsResult =
	| { outcome: "appended"; events: Array<{ seq: number }> }
	| RunWriteRejected;

/**
 * Append a non-empty ordered batch under one Run-row fence and transaction.
 * A complete Tool invocation uses this so start/arguments/completion can never
 * be split by interruption, ownership loss, or a database failure.
 */
export async function appendRunEventsTx(
	db: Database,
	input: {
		owner: RunWriteOwner;
		events: readonly { type: string; payload: RunEventPayload }[];
		appendClass: RunEventAppendClass;
	},
): Promise<AppendRunEventsResult> {
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
					claimedRunConditions(input.owner, input.owner.runId),
					inArray(runs.status, APPEND_CLASS_STATUSES[input.appendClass]),
					liveConversationOwnershipExists(input.owner),
				),
			)
			.returning({ nextEventSeq: runs.nextEventSeq });
		if (!allocated) {
			return {
				outcome: "rejected",
				...(await classifyFenceRejectionInTx(
					tx,
					claimedRunConditions(input.owner, input.owner.runId),
					liveConversationOwnershipExists(input.owner),
				)),
			};
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
			if (input.appendClass !== "model") {
				throw new InvalidRunEventError(
					"canonical model events require the model append class",
				);
			}
			const priorCanonicalEvents = await tx
				.select({ type: runEvents.type, payload: runEvents.payload })
				.from(runEvents)
				.where(
					and(
						eq(runEvents.runId, input.owner.runId),
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
			runId: input.owner.runId,
			seq: firstSeq + index,
			type: event.type,
			payload: event.payload,
		}));
		await tx.insert(runEvents).values(appended);
		return {
			outcome: "appended",
			events: appended.map(({ seq }) => ({ seq })),
		};
	});
}

/**
 * Move an owned run to a terminal status and append its one terminal event —
 * the fence, optional Agent-session pointer publication, the status CAS,
 * `terminal_at`, sequence allocation, and event insert are one transaction.
 * The fence makes double-terminalization impossible (the second caller finds
 * the Run already terminal and is rejected), which is what makes "exactly one
 * terminal event per run" hold. Only the live Claim's epoch may terminalize it.
 *
 * A refused fence is a {@link TerminalTransitionResult}, not an exception:
 * losing to a durable interruption is an ordinary outcome the caller resolves,
 * and the rejection says whether the lease is gone (stop — Reclamation owns the
 * Run) or the status simply moved on (and to what). Genuine failures still
 * throw.
 */
export async function transitionRunTerminalTx(
	db: Database,
	input: TerminalTransitionInput,
): Promise<TerminalTransitionResult> {
	return await executeTerminalRunTransaction(db, (tx) =>
		transitionRunTerminalInTx(tx, input),
	);
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
	owner: RunWriteOwner;
};

export type TerminalTransitionResult =
	| { outcome: "committed"; run: RunRecord }
	| RunWriteRejected;

/**
 * Take the terminal fence for `status` before any composed terminal facts. The
 * Run-row lock keeps status stable; the epoch is rechecked by the final status
 * update because it lives on the independently mutable Conversation row. Any
 * failed final recheck rolls the transaction back and is classified at the
 * public boundary. Returns `null` when the initial fence holds, or the
 * classified rejection (one extra read, same transaction).
 */
export async function lockRunForTerminalInTx(
	tx: DbTx,
	owner: RunWriteOwner,
	status: TerminalRunStatus,
): Promise<FenceRejection | null> {
	const [held] = await tx
		.select({ runId: runs.runId })
		.from(runs)
		.where(
			and(
				claimedRunConditions(owner, owner.runId),
				inArray(runs.status, TERMINAL_FROM_STATUSES[status]),
				liveConversationOwnershipExists(owner),
			),
		)
		.for("update");
	if (held) return null;
	return await classifyRunWriteRejectionInTx(tx, owner);
}

/**
 * Name why a fenced write found no row. One read, in the rejecting transaction
 * and only on the zero-row path, so the happy path pays nothing for it.
 *
 * `where` locates the Run the refused write addressed and `fenceHolds` is the
 * fence that write evaluated — the two things that differ between fenced writes.
 * The reading of the three cases does not differ and lives only here: no row at
 * all is a deleted Conversation (Runs cascade with it) rather than a lost lease,
 * and those tell the caller different things — one has nothing left to act on,
 * the other has a successor that does.
 */
async function classifyFenceRejectionInTx(
	tx: DbTx,
	where: SQL | undefined,
	fenceHolds: SQL,
): Promise<FenceRejection> {
	const [currentRun] = await tx
		.select({
			status: runs.status,
			fenceHolds: sql<boolean>`coalesce((${fenceHolds}), false)`,
		})
		.from(runs)
		.where(where)
		.limit(1);
	if (!currentRun) return { rejected: "gone" };
	if (!currentRun.fenceHolds) return { rejected: "lease" };
	return { rejected: "status", current: currentRun.status as RunStatus };
}

/**
 * Re-evaluate exactly the epoch fence the refused Run write evaluated. Keeping
 * the classifier on that authority is what distinguishes a live-epoch status
 * refusal from a lost Claim.
 */
function classifyRunWriteRejectionInTx(
	tx: DbTx,
	owner: RunWriteOwner,
): Promise<FenceRejection> {
	return classifyFenceRejectionInTx(
		tx,
		claimedRunConditions(owner, owner.runId),
		liveConversationOwnershipExists(owner),
	);
}

/** Internal rollback signal carrying the rejection classified in the same
 * transaction as the failed final epoch check. */
class TerminalFenceChangedError extends Error {
	override readonly name = "TerminalFenceChangedError";

	constructor(
		readonly rejection: FenceRejection,
		message: string,
	) {
		super(message);
	}
}

/** Run a terminal transaction, rolling back composed facts when its final epoch
 * check loses and returning the rejection classified before that rollback. */
export async function executeTerminalRunTransaction<T>(
	db: Database,
	operation: (tx: DbTx) => Promise<T>,
): Promise<T | RunWriteRejected> {
	try {
		return await db.transaction(operation);
	} catch (error) {
		if (!(error instanceof TerminalFenceChangedError)) throw error;
		return { outcome: "rejected", ...error.rejection };
	}
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
 * Commit the terminal status and one terminal event for a Run whose fence this
 * transaction already holds through
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
			"stale_worker is reserved for the Run liveness sweep",
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
			terminalAt: sql`now()`,
			updatedAt: sql`now()`,
		})
		.where(
			and(
				claimedRunConditions(input.owner, input.owner.runId),
				inArray(runs.status, TERMINAL_FROM_STATUSES[input.status]),
				liveConversationOwnershipExists(input.owner),
			),
		)
		.returning();
	if (!row) {
		const rejection = await classifyRunWriteRejectionInTx(tx, input.owner);
		throw new TerminalFenceChangedError(
			rejection,
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

export type MarkLiveStreamFailedResult =
	| { outcome: "marked" | "already_failed"; run: RunRecord }
	| RunWriteRejected;

/**
 * Monotonically record that a Run's Live Stream is unusable without changing
 * its execution status. Active writes require the same Ownership epoch fence
 * as model appends. A terminal Run is immutable, so terminal status alone
 * permits the idempotent NULL-to-time marker write; this lets a terminal Redis
 * publication failure safely race the terminal commit without depending on
 * any historical execution-provenance field.
 */
export async function markLiveStreamFailedTx(
	db: Database,
	input: { owner: RunWriteOwner },
): Promise<MarkLiveStreamFailedResult> {
	return await db.transaction(async (tx) => {
		const [before] = await tx
			.select()
			.from(runs)
			.where(claimedRunConditions(input.owner, input.owner.runId))
			.for("update");
		if (!before) return { outcome: "rejected", rejected: "gone" };

		const writeAllowed = or(
			and(
				inArray(runs.status, ["running", "interrupt_requested"]),
				liveConversationOwnershipExists(input.owner),
			),
			inArray(runs.status, TERMINAL_RUN_STATUSES),
		);
		if (before.liveStreamFailedAt !== null) {
			const [authorized] = await tx
				.select()
				.from(runs)
				.where(
					and(
						claimedRunConditions(input.owner, input.owner.runId),
						writeAllowed,
					),
				)
				.limit(1);
			if (authorized) {
				return { outcome: "already_failed", run: toRunRecord(authorized) };
			}
			return {
				outcome: "rejected",
				...(await classifyRunWriteRejectionInTx(tx, input.owner)),
			};
		}

		const [row] = await tx
			.update(runs)
			.set({
				liveStreamFailedAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					claimedRunConditions(input.owner, input.owner.runId),
					isNull(runs.liveStreamFailedAt),
					writeAllowed,
				),
			)
			.returning();
		if (!row) {
			return {
				outcome: "rejected",
				...(await classifyRunWriteRejectionInTx(tx, input.owner)),
			};
		}
		return {
			outcome: "marked",
			run: toRunRecord(row),
		};
	});
}

/**
 * Reclaim one Conversation whose Ownership lease lapsed without release. The
 * Conversation row is taken `FOR UPDATE SKIP LOCKED`, exactly as a Claim takes
 * it, so Claim, admission, and Reclamation cannot interleave on one
 * Conversation while concurrent reclaimers split work instead of blocking.
 *
 * One transaction terminalizes every started Active Run, taints the current
 * Workspace when command cleanup is unproven, and clears the Ownership columns.
 * Never-started queued Runs remain for the next Claim. An accepted interruption
 * remains `interrupted`; every running Run becomes `error`. The durable terminal
 * reason and Live Stream failure-marker behavior are unchanged.
 */
export async function reclaimConversationTx(
	db: Database,
): Promise<ReclaimedConversation | null> {
	return await db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({
				userId: conversations.userId,
				conversationId: conversations.conversationId,
			})
			.from(conversations)
			.where(sql`${conversations.ownerUntil} <= now()`)
			.for("update", { skipLocked: true })
			.limit(1);
		if (!candidate) return null;

		const runsToReclaim = await tx
			.select({
				runId: runs.runId,
				userId: runs.userId,
				conversationId: runs.conversationId,
				status: runs.status,
				liveStreamFailedAt: runs.liveStreamFailedAt,
			})
			.from(runs)
			.where(
				and(
					eq(runs.userId, candidate.userId),
					eq(runs.conversationId, candidate.conversationId),
					inArray(runs.status, ["running", "interrupt_requested"]),
				),
			)
			// Deliberately wait for a Run row rather than skip it: clearing Ownership
			// while omitting a started Run would strand that Run permanently. A holder
			// can only have locked this row before the lease lapsed, and these
			// transactions contain database work only (no provider, E2B, or network
			// calls), so the wait is bounded by that short transaction. Once it commits,
			// Postgres rechecks the status predicate before returning the row.
			.for("update");

		const terminalizedRuns = await terminalizeRunsForLivenessSweepInTx(
			tx,
			runsToReclaim,
		);
		const reclaimedRuns = terminalizedRuns.map(
			({ liveStreamFailureMarkedNow, ...run }) => ({
				...run,
				liveStreamFailureMarkedByReclamation: liveStreamFailureMarkedNow,
			}),
		);
		if (runsToReclaim.length > 0) {
			await taintRuntimeSandboxForReclamationInTx(tx, candidate);
		}
		// Preserve queued Runs without letting the unowned queue-age backstop race
		// the next Claim after Ownership is cleared. `created_at` remains the stable
		// submission/Claim order; `updated_at` starts a fresh timeout window because
		// these Runs were legitimately waiting behind the vanished owner's work.
		await tx
			.update(runs)
			.set({ updatedAt: sql`now()` })
			.where(
				and(
					eq(runs.userId, candidate.userId),
					eq(runs.conversationId, candidate.conversationId),
					eq(runs.status, "queued"),
				),
			);
		await tx
			.update(conversations)
			.set({ ownerWorkerId: null, ownerUntil: null })
			.where(
				and(
					eq(conversations.userId, candidate.userId),
					eq(conversations.conversationId, candidate.conversationId),
				),
			);

		return {
			userId: candidate.userId,
			conversationId: candidate.conversationId,
			runs: reclaimedRuns,
		};
	});
}

/**
 * Expire old queued Runs only when their Conversation is unowned and their
 * queue-backstop timestamp has also stayed old for the whole timeout. The
 * second deadline gives Runs preserved by Reclamation a fresh window to be
 * Claimed without changing their `created_at` queue order. The Conversation row
 * is locked with `FOR UPDATE SKIP LOCKED`, so this backstop cannot race
 * admission or Claim and never waits behind their lifecycle lock.
 */
export async function expireUnownedQueuedRunsTx(
	db: Database,
): Promise<ExpiredQueuedRuns | null> {
	return await db.transaction(async (tx) => {
		const result = await tx.execute<{
			user_id: string;
			conversation_id: string;
			execution_runtime: string;
		}>(sql`
			select c.user_id, c.conversation_id, c.execution_runtime
			  from ${runs} r
			  join ${conversations} c using (user_id, conversation_id)
			 where r.status = 'queued'
			   and greatest(r.created_at, r.updated_at) <= now() -
			     case c.execution_runtime
			       when ${FARGATE_EXECUTION_RUNTIME}
			         then interval '${sql.raw(String(FARGATE_UNOWNED_QUEUE_TIMEOUT_MS))} milliseconds'
			       when ${AGENTCORE_EXECUTION_RUNTIME}
			         then interval '${sql.raw(String(AGENTCORE_UNOWNED_QUEUE_TIMEOUT_MS))} milliseconds'
			     end
			   and c.owner_until is null
			 order by r.created_at
			   for update of c skip locked
			 limit 1
		`);
		const [candidateRow] = result.rows;
		const candidate = candidateRow
			? {
					userId: candidateRow.user_id,
					conversationId: candidateRow.conversation_id,
					executionRuntime: requireConversationExecutionRuntime(
						candidateRow.execution_runtime,
					),
				}
			: null;
		if (!candidate) return null;
		const timeoutMs =
			candidate.executionRuntime === FARGATE_EXECUTION_RUNTIME
				? FARGATE_UNOWNED_QUEUE_TIMEOUT_MS
				: AGENTCORE_UNOWNED_QUEUE_TIMEOUT_MS;

		const queuedRunsToExpire = await tx
			.select({
				runId: runs.runId,
				userId: runs.userId,
				conversationId: runs.conversationId,
				status: runs.status,
				liveStreamFailedAt: runs.liveStreamFailedAt,
			})
			.from(runs)
			.where(
				and(
					eq(runs.userId, candidate.userId),
					eq(runs.conversationId, candidate.conversationId),
					eq(runs.status, "queued"),
					sql`greatest(${runs.createdAt}, ${runs.updatedAt}) <= now() - interval '${sql.raw(String(timeoutMs))} milliseconds'`,
				),
			)
			.for("update");
		const terminalized = await terminalizeRunsForLivenessSweepInTx(
			tx,
			queuedRunsToExpire,
		);
		return {
			userId: candidate.userId,
			conversationId: candidate.conversationId,
			runs: terminalized.map(
				({ liveStreamFailureMarkedNow: _, ...run }) => run,
			),
		};
	});
}

type RunLivenessSweepCandidate = Pick<
	typeof runs.$inferSelect,
	"runId" | "status" | "liveStreamFailedAt"
>;

type RunLivenessSweepResult = RunRecord & {
	liveStreamFailureMarkedNow: boolean;
};

async function terminalizeRunsForLivenessSweepInTx(
	tx: DbTx,
	candidates: RunLivenessSweepCandidate[],
): Promise<RunLivenessSweepResult[]> {
	const terminalizedRuns: RunLivenessSweepResult[] = [];
	for (const candidate of candidates) {
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
				terminalAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(runs.runId, candidate.runId),
					// Compare-and-set: only a Run still Active can be terminalized, so
					// this transaction cannot overwrite an Outcome that landed first.
					inArray(runs.status, ACTIVE_RUN_STATUSES),
				),
			)
			.returning();
		if (!row) continue;
		// Preserve the existing durable terminal reason consumed by history.
		await insertTerminalEvent(tx, row, status, {
			...(status === "error" ? { message: "Run failed" } : {}),
			reason: "stale_worker",
		});
		terminalizedRuns.push({
			...toRunRecord(row),
			liveStreamFailureMarkedNow:
				candidate.status !== "queued" && candidate.liveStreamFailedAt === null,
		});
	}
	return terminalizedRuns;
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

/**
 * True when the error chain represents active-Run backpressure. Admission's
 * Active Run count is the only place it is raised, so this is a plain
 * cause-chain walk for callers that wrap admission in their own transaction.
 */
export function isActiveRunConflict(error: unknown): boolean {
	return inCauseChain(error, (e) => e instanceof ActiveRunConflictError);
}
