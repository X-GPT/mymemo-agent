import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { runEvents, runs } from "@/db/schema";

export const RUN_STATUSES = [
	"queued",
	"running",
	"cancel_requested",
	"done",
	"error",
	"canceled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_EVENT_VISIBILITIES = ["internal", "client"] as const;
export type RunEventVisibility = (typeof RUN_EVENT_VISIBILITIES)[number];

export const RUN_EVENT_TYPES = {
	runCreated: "run_created",
	runClaimed: "run_claimed",
	runCancelRequested: "run_cancel_requested",
	runDone: "run_done",
	runError: "run_error",
	runCanceled: "run_canceled",
} as const;
export type RunEventType =
	(typeof RUN_EVENT_TYPES)[keyof typeof RUN_EVENT_TYPES];

export interface OwnedRunRef {
	runId: string;
	workerId: string;
	fencingToken: number;
}

export interface CreateQueuedRunInput {
	runId: string;
	userId: string;
	conversationId: string;
}

export type CreateQueuedRunResult =
	| {
			status: "created";
			runId: string;
			runStatus: Extract<RunStatus, "queued">;
			eventSeq: number;
	  }
	| { status: "active_run_exists" };

export interface ClaimNextRunInput {
	workerId: string;
	ttlMs: number;
}

export interface ClaimedRun extends OwnedRunRef {
	userId: string;
	conversationId: string;
	lockedUntil: Date;
}

export type AppendRunEventMode =
	| { kind: "owner_running"; owner: OwnedRunRef }
	| { kind: "owner_running_or_cancel_requested"; owner: OwnedRunRef };

export interface AppendRunEventInput {
	mode: AppendRunEventMode;
	type: string;
	visibility: RunEventVisibility;
	payload: JsonPayload;
}

export type AppendRunEventResult =
	| { status: "appended"; seq: number }
	| { status: "not_appendable" };

export interface HeartbeatRunInput extends OwnedRunRef {
	ttlMs: number;
}

export type HeartbeatRunResult =
	| { status: "ok"; lockedUntil: Date }
	| { status: "lost_ownership" };

export interface RequestRunCancellationInput {
	userId: string;
	conversationId: string;
	runId: string;
	requestedBy?: string;
	reason?: string;
}

export type RequestRunCancellationResult =
	| { status: "canceled"; eventSeq: number }
	| { status: "requested"; eventSeq: number | null }
	| { status: "already_terminal"; runStatus: ExtractTerminalStatus<RunStatus> }
	| { status: "not_found" };

export type TerminalTransitionKind = "success" | "failure" | "cancellation";

export interface TransitionRunTerminalInput extends OwnedRunRef {
	transition: TerminalTransitionKind;
	message?: string;
}

export type TransitionRunTerminalResult =
	| {
			status: "transitioned";
			runStatus: ExtractTerminalStatus<RunStatus>;
			eventSeq: number;
	  }
	| { status: "lost_ownership_or_not_transitionable" };

export interface RecoverOneStaleRunInput {
	message?: string;
}

export type RecoverOneStaleRunResult = {
	runId: string;
	userId: string;
	conversationId: string;
	runStatus: Extract<RunStatus, "error" | "canceled">;
	eventSeq: number;
} | null;

type ExtractTerminalStatus<T extends RunStatus> = Extract<
	T,
	"done" | "error" | "canceled"
>;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RunStoreTx = Database | Transaction;
type JsonPayload = Record<string, unknown>;

const STALE_WORKER_MESSAGE =
	"The run was stopped because its worker became unavailable.";
const DEFAULT_ERROR_MESSAGE = "The run failed.";

export async function createQueuedRunTx(
	db: Database,
	input: CreateQueuedRunInput,
): Promise<CreateQueuedRunResult> {
	return db.transaction(async (tx) => {
		try {
			await tx.insert(runs).values({
				runId: input.runId,
				userId: input.userId,
				conversationId: input.conversationId,
				status: "queued",
				fencingToken: 0,
				nextEventSeq: 1,
			});
		} catch (error) {
			if (isActiveRunUniqueViolation(error)) {
				return { status: "active_run_exists" };
			}
			throw error;
		}

		const event = await appendRunEventInTx(tx, {
			runId: input.runId,
			type: RUN_EVENT_TYPES.runCreated,
			visibility: "internal",
			payload: {
				userId: input.userId,
				conversationId: input.conversationId,
				runId: input.runId,
			},
			where: eq(runs.runId, input.runId),
		});
		if (!event) throw new Error("created run disappeared before event append");

		return {
			status: "created",
			runId: input.runId,
			runStatus: "queued",
			eventSeq: event.seq,
		};
	});
}

export async function claimNextRunTx(
	db: Database,
	input: ClaimNextRunInput,
): Promise<ClaimedRun | null> {
	return db.transaction(async (tx) => {
		const rows = await executeRows<{
			run_id: string;
			user_id: string;
			conversation_id: string;
			fencing_token: number | string;
			locked_until: Date | string;
		}>(
			tx,
			sql`
				WITH candidate AS (
					SELECT run_id
					FROM runs
					WHERE status = 'queued'
					ORDER BY created_at, run_id
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				)
				UPDATE runs
				SET status = 'running',
					locked_by = ${input.workerId},
					locked_until = ${expiresAt(input.ttlMs)},
					heartbeat_at = now(),
					fencing_token = fencing_token + 1,
					updated_at = now()
				FROM candidate
				WHERE runs.run_id = candidate.run_id
					AND runs.status = 'queued'
				RETURNING runs.run_id, runs.user_id, runs.conversation_id, runs.fencing_token, runs.locked_until
			`,
		);
		const row = rows[0];
		if (!row) return null;

		const event = await appendRunEventInTx(tx, {
			runId: row.run_id,
			type: RUN_EVENT_TYPES.runClaimed,
			visibility: "internal",
			payload: { workerId: input.workerId },
			where: ownedBy({
				runId: row.run_id,
				workerId: input.workerId,
				fencingToken: Number(row.fencing_token),
			}),
		});
		if (!event)
			throw new Error("claimed run lost ownership before event append");

		return {
			runId: row.run_id,
			userId: row.user_id,
			conversationId: row.conversation_id,
			workerId: input.workerId,
			fencingToken: Number(row.fencing_token),
			lockedUntil: asDate(row.locked_until),
		};
	});
}

export async function appendRunEventTx(
	db: Database,
	input: AppendRunEventInput,
): Promise<AppendRunEventResult> {
	return db.transaction(async (tx) => {
		const event = await appendRunEventInTx(tx, {
			runId: input.mode.owner.runId,
			type: input.type,
			visibility: input.visibility,
			payload: input.payload,
			where: appendModeWhere(input.mode),
		});
		if (!event) return { status: "not_appendable" };
		return { status: "appended", seq: event.seq };
	});
}

export async function heartbeatRunTx(
	db: Database,
	input: HeartbeatRunInput,
): Promise<HeartbeatRunResult> {
	return db.transaction(async (tx) => {
		const rows = await tx
			.update(runs)
			.set({
				lockedUntil: expiresAt(input.ttlMs),
				heartbeatAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(ownedBy(input))
			.returning({ lockedUntil: runs.lockedUntil });

		const row = rows[0];
		if (!row?.lockedUntil) return { status: "lost_ownership" };
		return { status: "ok", lockedUntil: row.lockedUntil };
	});
}

export async function requestRunCancellationTx(
	db: Database,
	input: RequestRunCancellationInput,
): Promise<RequestRunCancellationResult> {
	return db.transaction(async (tx) => {
		const currentRows = await tx
			.select({ status: runs.status })
			.from(runs)
			.where(runIdentity(input))
			.limit(1)
			.for("update");
		const current = currentRows[0];
		if (!current) return { status: "not_found" };

		if (isTerminalStatus(current.status)) {
			return { status: "already_terminal", runStatus: current.status };
		}

		if (current.status === "cancel_requested") {
			return { status: "requested", eventSeq: null };
		}

		if (current.status === "queued") {
			const updated = await tx
				.update(runs)
				.set({
					status: "canceled",
					lockedBy: null,
					lockedUntil: null,
					heartbeatAt: null,
					cancelRequestedAt: sql`now()`,
					terminalAt: sql`now()`,
					updatedAt: sql`now()`,
				})
				.where(and(runIdentity(input), eq(runs.status, "queued")))
				.returning({ runId: runs.runId });
			if (!updated[0]) return { status: "not_found" };

			const event = await appendRunEventInTx(tx, {
				runId: input.runId,
				type: RUN_EVENT_TYPES.runCanceled,
				visibility: "client",
				payload: {},
				where: eq(runs.runId, input.runId),
			});
			if (!event)
				throw new Error("canceled run disappeared before event append");
			return { status: "canceled", eventSeq: event.seq };
		}

		const updated = await tx
			.update(runs)
			.set({
				status: "cancel_requested",
				cancelRequestedAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(and(runIdentity(input), eq(runs.status, "running")))
			.returning({ runId: runs.runId });
		if (!updated[0]) return { status: "not_found" };

		const payload: JsonPayload = {};
		if (input.requestedBy !== undefined)
			payload.requestedBy = input.requestedBy;
		if (input.reason !== undefined) payload.reason = input.reason;
		const event = await appendRunEventInTx(tx, {
			runId: input.runId,
			type: RUN_EVENT_TYPES.runCancelRequested,
			visibility: "internal",
			payload,
			where: eq(runs.runId, input.runId),
		});
		if (!event)
			throw new Error("cancel-requested run disappeared before event append");
		return { status: "requested", eventSeq: event.seq };
	});
}

export async function transitionRunTerminalTx(
	db: Database,
	input: TransitionRunTerminalInput,
): Promise<TransitionRunTerminalResult> {
	return db.transaction(async (tx) => {
		const spec = terminalSpec(input);
		const updated = await tx
			.update(runs)
			.set({
				status: spec.status,
				lockedBy: null,
				lockedUntil: null,
				heartbeatAt: null,
				terminalAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(and(ownedBy(input), inArray(runs.status, spec.fromStatuses)))
			.returning({ runId: runs.runId });

		if (!updated[0]) {
			return { status: "lost_ownership_or_not_transitionable" };
		}

		const event = await appendRunEventInTx(tx, {
			runId: input.runId,
			type: spec.eventType,
			visibility: "client",
			payload: spec.payload,
			where: eq(runs.runId, input.runId),
		});
		if (!event) throw new Error("terminal run disappeared before event append");

		return {
			status: "transitioned",
			runStatus: spec.status,
			eventSeq: event.seq,
		};
	});
}

export async function recoverOneStaleRunTx(
	db: Database,
	input: RecoverOneStaleRunInput = {},
): Promise<RecoverOneStaleRunResult> {
	return db.transaction(async (tx) => {
		const candidates = await tx
			.select({
				runId: runs.runId,
				userId: runs.userId,
				conversationId: runs.conversationId,
				status: runs.status,
			})
			.from(runs)
			.where(
				and(
					inArray(runs.status, ["running", "cancel_requested"]),
					lt(runs.lockedUntil, sql`now()`),
				),
			)
			.orderBy(runs.lockedUntil, runs.createdAt, runs.runId)
			.limit(1)
			.for("update", { skipLocked: true });
		const candidate = candidates[0];
		if (!candidate) return null;

		const staleWasCancelRequested = candidate.status === "cancel_requested";
		const runStatus = staleWasCancelRequested ? "canceled" : "error";
		const eventType = staleWasCancelRequested
			? RUN_EVENT_TYPES.runCanceled
			: RUN_EVENT_TYPES.runError;
		const payload = staleWasCancelRequested
			? {}
			: { message: safeErrorMessage(input.message ?? STALE_WORKER_MESSAGE) };

		const updated = await tx
			.update(runs)
			.set({
				status: runStatus,
				lockedBy: null,
				lockedUntil: null,
				heartbeatAt: null,
				fencingToken: sql`${runs.fencingToken} + 1`,
				terminalAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(runs.runId, candidate.runId),
					eq(runs.status, candidate.status),
					lt(runs.lockedUntil, sql`now()`),
				),
			)
			.returning({ runId: runs.runId });
		if (!updated[0]) return null;

		const event = await appendRunEventInTx(tx, {
			runId: candidate.runId,
			type: eventType,
			visibility: "client",
			payload,
			where: eq(runs.runId, candidate.runId),
		});
		if (!event) throw new Error("stale run disappeared before event append");

		return {
			runId: candidate.runId,
			userId: candidate.userId,
			conversationId: candidate.conversationId,
			runStatus,
			eventSeq: event.seq,
		};
	});
}

async function appendRunEventInTx(
	tx: RunStoreTx,
	input: {
		runId: string;
		type: string;
		visibility: RunEventVisibility;
		payload: JsonPayload;
		where: ReturnType<typeof and> | ReturnType<typeof eq>;
	},
): Promise<{ seq: number } | null> {
	const seqRows = await tx
		.update(runs)
		.set({
			nextEventSeq: sql`${runs.nextEventSeq} + 1`,
			updatedAt: sql`now()`,
		})
		.where(input.where)
		.returning({ seq: sql<number>`${runs.nextEventSeq} - 1` });
	const seq = seqRows[0]?.seq;
	if (seq === undefined) return null;

	await tx.insert(runEvents).values({
		runId: input.runId,
		seq: Number(seq),
		type: input.type,
		visibility: input.visibility,
		payload: input.payload,
	});

	return { seq: Number(seq) };
}

function appendModeWhere(mode: AppendRunEventMode) {
	const statusClause =
		mode.kind === "owner_running"
			? eq(runs.status, "running")
			: inArray(runs.status, ["running", "cancel_requested"]);
	return and(ownedBy(mode.owner), statusClause);
}

function ownedBy(ref: OwnedRunRef) {
	return and(
		eq(runs.runId, ref.runId),
		eq(runs.lockedBy, ref.workerId),
		eq(runs.fencingToken, ref.fencingToken),
		sql`${runs.lockedUntil} > now()`,
	);
}

function runIdentity(input: {
	userId: string;
	conversationId: string;
	runId: string;
}) {
	return and(
		eq(runs.userId, input.userId),
		eq(runs.conversationId, input.conversationId),
		eq(runs.runId, input.runId),
	);
}

function terminalSpec(input: TransitionRunTerminalInput): {
	status: ExtractTerminalStatus<RunStatus>;
	fromStatuses: Array<Extract<RunStatus, "running" | "cancel_requested">>;
	eventType: RunEventType;
	payload: JsonPayload;
} {
	if (input.transition === "success") {
		return {
			status: "done",
			fromStatuses: ["running"],
			eventType: RUN_EVENT_TYPES.runDone,
			payload: {},
		};
	}
	if (input.transition === "failure") {
		return {
			status: "error",
			fromStatuses: ["running", "cancel_requested"],
			eventType: RUN_EVENT_TYPES.runError,
			payload: { message: safeErrorMessage(input.message) },
		};
	}
	return {
		status: "canceled",
		fromStatuses: ["running", "cancel_requested"],
		eventType: RUN_EVENT_TYPES.runCanceled,
		payload: {},
	};
}

function isTerminalStatus(
	status: string,
): status is ExtractTerminalStatus<RunStatus> {
	return status === "done" || status === "error" || status === "canceled";
}

function safeErrorMessage(message: unknown): string {
	if (typeof message !== "string") return DEFAULT_ERROR_MESSAGE;
	const trimmed = message.trim();
	return trimmed ? trimmed : DEFAULT_ERROR_MESSAGE;
}

function expiresAt(ttlMs: number) {
	return sql`now() + make_interval(secs => ${ttlMs / 1000})`;
}

function asDate(value: Date | string): Date {
	return value instanceof Date ? value : new Date(value);
}

function isActiveRunUniqueViolation(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const maybe = error as {
		code?: unknown;
		constraint?: unknown;
		cause?: unknown;
	};
	return (
		(maybe.code === "23505" &&
			maybe.constraint === "runs_one_active_per_conversation") ||
		isActiveRunUniqueViolation(maybe.cause)
	);
}

async function executeRows<T>(tx: RunStoreTx, query: ReturnType<typeof sql>) {
	const result = await tx.execute(query);
	if (Array.isArray(result)) return result as T[];
	if (result && typeof result === "object" && "rows" in result) {
		return (result as { rows: T[] }).rows;
	}
	return [] as T[];
}
