import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Database } from "./client";
import { type DbTx, RunFenceError } from "./run-store";
import { conversationRuntime, orphanSandboxes, runs } from "./schema";

/**
 * Narrow transaction helpers over `conversation_runtime` and
 * `orphan_sandboxes` — the only write path for persistent E2B workspace
 * metadata (design doc "State Ownership", Task 4.2). Shared by chat-api (which
 * owns run admission and conversation records) and agent-worker (which mutates
 * the sandbox and session pointers through these helpers), so the fenced write
 * protocol lives in exactly one place over one `pg` driver.
 * The table grants no execution ownership of its own: every mutation is fenced
 * on the claiming run's ownership in `runs` (`status` active,
 * `locked_by = workerId`, `locked_until > now()`): every update carries the
 * fence as an `EXISTS` subquery inside the same statement that performs the
 * write, and row creation checks the same predicate `FOR SHARE` in its
 * transaction — so a worker that stalls past its lock cannot overwrite pointers
 * a recovered conversation now relies on. The one deliberate exception is
 * orphan recording, which exists precisely for the ownership-already-lost path.
 *
 * `interrupt_requested` is inside the fence (mirroring the run-store
 * "cancellation" append class): command cleanup while an interruption stops
 * the run is where sandbox taint decisions happen, and those must stay
 * durable.
 */

/** Run statuses under which the owning worker may mutate runtime metadata. */
const OWNED_ACTIVE_STATUSES = ["running", "interrupt_requested"] as const;

/** A persisted runtime row. */
export type ConversationRuntimeRecord = typeof conversationRuntime.$inferSelect;

/**
 * The identity a fenced mutation acts under: the conversation's runtime row
 * being mutated plus the run/worker whose live ownership authorizes it.
 */
export interface RunOwnershipRef {
	userId: string;
	conversationId: string;
	runId: string;
	workerId: string;
}

/**
 * The ownership fence as conditions on `runs`: satisfiable only while
 * `workerId` holds the named run for this exact conversation with an
 * unexpired lock. The single source of the fence — both the `EXISTS` form
 * and the create-path `FOR SHARE` check are built from it.
 */
function ownedRunConditions(owner: RunOwnershipRef) {
	return and(
		eq(runs.runId, owner.runId),
		eq(runs.userId, owner.userId),
		eq(runs.conversationId, owner.conversationId),
		inArray(runs.status, [...OWNED_ACTIVE_STATUSES]),
		eq(runs.lockedBy, owner.workerId),
		sql`${runs.lockedUntil} > now()`,
	);
}

/** {@link ownedRunConditions} as a predicate a mutating statement carries
 * inside itself, never as a separate app-side check. */
function ownedRunExists(owner: RunOwnershipRef) {
	return sql`exists (select 1 from ${runs} where ${ownedRunConditions(owner)})`;
}

function fenceRejected(owner: RunOwnershipRef, operation: string): never {
	throw new RunFenceError(
		`${operation} for conversation ${owner.conversationId} rejected: ` +
			`worker ${owner.workerId} no longer owns run ${owner.runId}`,
	);
}

/** Load the runtime row, or `null` when the conversation has none yet.
 * Reads are not fenced — only mutations need ownership. */
export async function loadConversationRuntimeTx(
	db: Database,
	input: { userId: string; conversationId: string },
): Promise<ConversationRuntimeRecord | null> {
	const [row] = await db
		.select()
		.from(conversationRuntime)
		.where(
			and(
				eq(conversationRuntime.userId, input.userId),
				eq(conversationRuntime.conversationId, input.conversationId),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Create the conversation's runtime row (empty pointers). The fence
 * is checked `FOR SHARE` in the same transaction as the insert, so stale-run
 * recovery cannot terminalize the authorizing run between check and insert.
 * Idempotent: if a previous attempt already created the row, the existing row
 * is returned unchanged (concurrent creators are impossible — the partial
 * unique index on `runs` allows only one active run per conversation).
 */
export async function createConversationRuntimeTx(
	db: Database,
	owner: RunOwnershipRef,
): Promise<ConversationRuntimeRecord> {
	return await db.transaction(async (tx) => {
		const owned = await tx
			.select({ runId: runs.runId })
			.from(runs)
			.where(ownedRunConditions(owner))
			.for("share");
		if (!owned[0]) fenceRejected(owner, "runtime row creation");

		const [inserted] = await tx
			.insert(conversationRuntime)
			.values({ userId: owner.userId, conversationId: owner.conversationId })
			.onConflictDoNothing()
			.returning();
		if (inserted) return inserted;

		const [existing] = await tx
			.select()
			.from(conversationRuntime)
			.where(
				and(
					eq(conversationRuntime.userId, owner.userId),
					eq(conversationRuntime.conversationId, owner.conversationId),
				),
			);
		if (!existing) {
			throw new Error(
				`runtime row for conversation ${owner.conversationId} vanished mid-transaction`,
			);
		}
		return existing;
	});
}

/**
 * Store (or clear, with `null`) the conversation's current sandbox pointer.
 * Always resets `sandbox_tainted`: a newly stored pointer names a
 * just-created/just-verified sandbox, and a cleared pointer has nothing left
 * to taint. Taint is only ever set through {@link markRuntimeSandboxTaintedTx}.
 */
export async function updateRuntimeSandboxTx(
	db: Database,
	input: RunOwnershipRef & { sandboxId: string | null },
): Promise<ConversationRuntimeRecord> {
	return await fencedRuntimeUpdate(db, input, "sandbox pointer update", {
		sandboxId: input.sandboxId,
		sandboxTainted: false,
	});
}

/**
 * One fenced runtime UPDATE: the ownership predicate rides inside the same
 * statement as the write. Zero rows means the fence rejected (or the row was
 * never created — equally a caller that must stop treating the run as its
 * own), surfaced as {@link RunFenceError}.
 */
async function fencedRuntimeUpdate(
	db: Pick<Database, "update">,
	owner: RunOwnershipRef,
	operation: string,
	set: PgUpdateSetSource<typeof conversationRuntime>,
): Promise<ConversationRuntimeRecord> {
	const [row] = await db
		.update(conversationRuntime)
		.set({ ...set, updatedAt: sql`now()` })
		.where(
			and(
				eq(conversationRuntime.userId, owner.userId),
				eq(conversationRuntime.conversationId, owner.conversationId),
				ownedRunExists(owner),
			),
		)
		.returning();
	if (!row) fenceRejected(owner, operation);
	return row;
}

/**
 * Mark the current sandbox tainted (command cleanup unproven): the pointer is
 * kept so cleanup can find and kill it, but the sandbox must not be
 * reused until replaced via {@link updateRuntimeSandboxTx}.
 */
export async function markRuntimeSandboxTaintedTx(
	db: Database,
	owner: RunOwnershipRef,
): Promise<ConversationRuntimeRecord> {
	return await fencedRuntimeUpdate(db, owner, "sandbox taint mark", {
		sandboxTainted: true,
	});
}

/**
 * Advance the conversation's Claude Agent SDK resume pointer to `agentSessionId`
 * (ADR-0005, Task 7.3). Fenced like every other runtime mutation, so this is
 * exactly what makes "the pointer advances only in the terminal-success
 * transition, and a stale worker cannot move it" true: a worker that lost the
 * run gets a {@link RunFenceError} and the pointer stays where the owner left
 * it. The caller advances it only after a turn terminalizes `done` with a clean
 * mirror; a `mirror_error` turn simply never calls this.
 */
export async function advanceAgentSessionPointerTx(
	db: Database,
	input: RunOwnershipRef & { agentSessionId: string },
): Promise<ConversationRuntimeRecord> {
	return await fencedRuntimeUpdate(db, input, "agent session pointer advance", {
		agentSessionId: input.agentSessionId,
	});
}

/**
 * Transaction-scoped form of {@link advanceAgentSessionPointerTx}. Artifact
 * publication uses it so the canonical runtime fence and `run_done` share the
 * caller's transaction.
 */
export async function advanceAgentSessionPointerInTx(
	tx: DbTx,
	input: RunOwnershipRef & { agentSessionId: string },
): Promise<ConversationRuntimeRecord> {
	return await fencedRuntimeUpdate(tx, input, "agent session pointer advance", {
		agentSessionId: input.agentSessionId,
	});
}

/** A persisted orphan-ledger row. */
export type OrphanSandboxRecord = typeof orphanSandboxes.$inferSelect;

/**
 * Record a sandbox that escaped database ownership (created, then the fenced
 * pointer update failed and the kill could not be confirmed). Deliberately
 * unfenced — this path exists precisely because run ownership is already
 * lost. Idempotent per sandbox id: re-recording returns the original row
 * unchanged, so a retrying worker cannot overwrite the first record.
 */
export async function recordOrphanSandboxTx(
	db: Database,
	input: typeof orphanSandboxes.$inferInsert,
): Promise<OrphanSandboxRecord> {
	const [inserted] = await db
		.insert(orphanSandboxes)
		.values(input)
		.onConflictDoNothing()
		.returning();
	if (inserted) return inserted;

	const [existing] = await db
		.select()
		.from(orphanSandboxes)
		.where(eq(orphanSandboxes.sandboxId, input.sandboxId));
	if (!existing) {
		throw new Error(
			`orphan record for sandbox ${input.sandboxId} vanished between insert and read`,
		);
	}
	return existing;
}
