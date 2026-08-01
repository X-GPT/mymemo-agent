import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Database, DbTx } from "./client";
import {
	ownedRunByUserConditions,
	ownedRunByUserExists,
	rejectRunFence,
	type UserRunMutationOwner,
} from "./run-ownership";
import { conversationRuntime, orphanSandboxes, runs } from "./schema";

/**
 * Narrow transaction helpers over `conversation_runtime` and
 * `orphan_sandboxes`, plus the named in-transaction Agent-session pointer
 * operation used by terminal Run transactions (design doc "State Ownership",
 * Task 4.2). Shared by chat-api and agent-worker so the runtime write protocol
 * lives in one place over one `pg` driver. Sandbox/taint helpers live here;
 * Agent-session pointer publication is composed by run-store with the terminal
 * Outcome.
 * The table grants no execution ownership of its own: every mutation is fenced
 * on the claiming run's ownership in `runs` (`status` active,
 * `locked_by = workerId`, `locked_until > now()`): every update carries the
 * fence as an `EXISTS` subquery inside the same statement that performs the
 * write, and row creation checks the same predicate `FOR SHARE` in its
 * transaction — so a worker that stalls past its lock cannot overwrite pointers
 * a recovered conversation now relies on. The two deliberate exceptions are
 * orphan recording and Reclamation taint, which exist precisely for the
 * ownership-already-lost path.
 *
 * `interrupt_requested` is inside the fence (mirroring the run-store
 * "cancellation" append class): command cleanup while an interruption stops
 * the run is where sandbox taint decisions happen, and those must stay
 * durable.
 */

/** A persisted runtime row. */
export type ConversationRuntimeRecord = typeof conversationRuntime.$inferSelect;

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
 * is checked `FOR SHARE` in the same transaction as the insert, so Reclamation
 * cannot terminalize the authorizing Run between check and insert.
 * Idempotent: if a previous attempt already created the row, the existing row
 * is returned unchanged. Idempotency is for the retry, not for concurrency: the
 * authorizing Run's lease is what makes the Conversation single-writer.
 */
export async function createConversationRuntimeTx(
	db: Database,
	owner: UserRunMutationOwner,
): Promise<ConversationRuntimeRecord> {
	return await db.transaction(async (tx) => {
		const owned = await tx
			.select({ runId: runs.runId })
			.from(runs)
			.where(ownedRunByUserConditions(owner))
			.for("share");
		if (!owned[0]) rejectRunFence(owner, "runtime row creation");

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
 * to taint. Taint is only ever set through {@link markRuntimeSandboxTaintedTx}
 * or {@link taintRecoveredRuntimeSandboxInTx}.
 */
export async function updateRuntimeSandboxTx(
	db: Database,
	input: UserRunMutationOwner & { sandboxId: string | null },
): Promise<ConversationRuntimeRecord> {
	const row = await tryUpdateRuntimeRow(db, input, {
		sandboxId: input.sandboxId,
		sandboxTainted: false,
	});
	if (!row) rejectRunFence(input, "sandbox pointer update");
	return row;
}

/**
 * Publish a proven Agent-session pointer inside its caller's terminal
 * transaction. The update carries the ownership fence in-statement. A missing
 * optional runtime row leaves the pointer unpublished; a stale owner is still
 * rejected by the terminal CAS in the same transaction.
 */
export async function publishAgentSessionPointerInTx(
	tx: DbTx,
	owner: UserRunMutationOwner,
	agentSessionId: string,
): Promise<void> {
	await tryUpdateRuntimeRow(tx, owner, { agentSessionId });
}

async function tryUpdateRuntimeRow(
	db: Pick<Database, "update">,
	owner: UserRunMutationOwner,
	set: PgUpdateSetSource<typeof conversationRuntime>,
): Promise<ConversationRuntimeRecord | null> {
	const [row] = await db
		.update(conversationRuntime)
		.set({ ...set, updatedAt: sql`now()` })
		.where(
			and(
				eq(conversationRuntime.userId, owner.userId),
				eq(conversationRuntime.conversationId, owner.conversationId),
				ownedRunByUserExists(owner),
			),
		)
		.returning();
	return row ?? null;
}

/**
 * Mark the current sandbox tainted (command cleanup unproven): the pointer is
 * kept so cleanup can find and kill it, but the sandbox must not be
 * reused until replaced via {@link updateRuntimeSandboxTx}.
 */
export async function markRuntimeSandboxTaintedTx(
	db: Database,
	owner: UserRunMutationOwner,
): Promise<ConversationRuntimeRecord> {
	const row = await tryUpdateRuntimeRow(db, owner, { sandboxTainted: true });
	if (!row) rejectRunFence(owner, "sandbox taint mark");
	return row;
}

/**
 * Taint the Conversation's sandbox from Reclamation, inside Reclamation's own
 * transaction. The second deliberate exception to the ownership fence, and
 * for the same reason as orphan recording: the run whose ownership would
 * authorize the write is precisely the run that lost it, and its worker may be
 * partitioned rather than dead — still writing to a workspace the next turn
 * would otherwise reconnect to. Restricted to conversations that actually hold
 * a sandbox, so taint keeps describing the current sandbox only.
 */
export async function taintRecoveredRuntimeSandboxInTx(
	tx: DbTx,
	input: { userId: string; conversationId: string },
): Promise<void> {
	await tx
		.update(conversationRuntime)
		.set({ sandboxTainted: true, updatedAt: sql`now()` })
		.where(
			and(
				eq(conversationRuntime.userId, input.userId),
				eq(conversationRuntime.conversationId, input.conversationId),
				isNotNull(conversationRuntime.sandboxId),
			),
		);
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
