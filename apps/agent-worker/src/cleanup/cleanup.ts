import type { Database } from "@mymemo/agent-db/client";
import {
	conversationRuntime,
	conversations,
	orphanSandboxes,
} from "@mymemo/agent-db/schema";
import { deleteConversationAgentSessionsTx } from "@mymemo/agent-db/session-store";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { WorkerLogger } from "../logger";

/**
 * Runtime hygiene for external E2B resources Postgres cannot delete
 * transactionally (design doc "Why Cleanup Exists", Task 8.1; retargeted by
 * ADR-0007): orphaned sandboxes, and runtime rows for deleted
 * conversations/users. Exactly these two sweeps — both cost-independent; there
 * is deliberately no idle reaper for paused sandboxes (a paused sandbox *is*
 * the conversation's workspace and persists at no documented cost on the
 * current tier). The database is the source of truth for what is *referenced*;
 * the janitor reconciles E2B against it. The one rule everything here obeys:
 * never kill a sandbox still referenced by `conversation_runtime`.
 *
 * The pass is deliberately unfenced (it runs when no run owns a conversation)
 * but conservative, idempotent, and per-row isolated: every E2B call is
 * idempotent (kill of an already-gone resource resolves), a failing row is
 * left in place to retry on the next pass, and a failing sweep never aborts
 * the other — so cleanup can never block unrelated user runs.
 */

/**
 * The narrow E2B port cleanup needs, injected like the other executor tools'
 * sandbox clients (no concrete E2B wiring lives in worker production code yet).
 * The operation must be idempotent: killing a sandbox that is already gone
 * resolves successfully; only a real, retryable failure rejects.
 */
export interface SandboxJanitor {
	/** Kill an E2B sandbox by id. Resolve if killed or already gone. */
	killSandbox(sandboxId: string): Promise<void>;
}

/** Per-pass tallies, returned for structured logging and asserted by tests. */
export interface CleanupSummary {
	orphanSandboxesKilled: number;
	orphanSandboxesFailed: number;
	orphanSandboxesSkippedReferenced: number;
	deletedRuntimesRemoved: number;
	deletedRuntimesRetained: number;
}

export interface CleanupPassOptions {
	db: Database;
	janitor: SandboxJanitor;
	/** Records who recorded an orphan when a deleted-conversation kill fails. */
	workerId: string;
	logger: WorkerLogger;
}

function zeroSummary(): CleanupSummary {
	return {
		orphanSandboxesKilled: 0,
		orphanSandboxesFailed: 0,
		orphanSandboxesSkippedReferenced: 0,
		deletedRuntimesRemoved: 0,
		deletedRuntimesRetained: 0,
	};
}

/**
 * One cleanup pass: the two sweeps, each isolated so a whole-sweep failure
 * (e.g. a transient DB error) is logged and the remaining sweep still runs.
 * Returns the merged per-sweep tallies.
 */
export async function runCleanupPass(
	options: CleanupPassOptions,
): Promise<CleanupSummary> {
	const summary = zeroSummary();
	await runSweep(options.logger, "orphan-sandboxes", async () => {
		Object.assign(summary, await sweepOrphanSandboxes(options));
	});
	await runSweep(options.logger, "deleted-conversations", async () => {
		Object.assign(summary, await sweepDeletedConversations(options));
	});
	return summary;
}

async function runSweep(
	logger: WorkerLogger,
	sweep: string,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (error) {
		logger.error({
			message: "cleanup sweep failed",
			sweep,
			error: toMessage(error),
		});
	}
}

/**
 * Kill sandboxes recorded in the `orphan_sandboxes` ledger — but never one that
 * is currently a conversation's live pointer (the ledger records at the moment
 * ownership was lost, so a legitimately-owned sandbox should never appear, yet
 * we check anyway and leave any referenced entry untouched). A confirmed kill
 * removes the ledger row; a failed kill leaves it to retry next pass.
 */
async function sweepOrphanSandboxes(
	options: CleanupPassOptions,
): Promise<Partial<CleanupSummary>> {
	const { db, janitor, logger } = options;
	const orphans = await db.select().from(orphanSandboxes);
	if (orphans.length === 0) return {};

	const referenced = await referencedSandboxIds(db);
	let killed = 0;
	let failed = 0;
	let skipped = 0;
	for (const orphan of orphans) {
		if (referenced.has(orphan.sandboxId)) {
			skipped++;
			logger.warn({
				message: "orphan sandbox is still referenced; leaving it",
				sandboxId: orphan.sandboxId,
			});
			continue;
		}
		try {
			await janitor.killSandbox(orphan.sandboxId);
		} catch (error) {
			failed++;
			logger.warn({
				message: "orphan sandbox kill failed; will retry",
				sandboxId: orphan.sandboxId,
				error: toMessage(error),
			});
			continue;
		}
		await db
			.delete(orphanSandboxes)
			.where(eq(orphanSandboxes.sandboxId, orphan.sandboxId));
		killed++;
	}
	return {
		orphanSandboxesKilled: killed,
		orphanSandboxesFailed: failed,
		orphanSandboxesSkippedReferenced: skipped,
	};
}

/**
 * Remove `conversation_runtime` rows whose conversation no longer exists (a
 * deleted conversation or user), killing the sandbox first — the user deleted
 * the conversation, so the sandbox holding their files must die
 * (privacy/correctness). The runtime row (and its pointer) is only removed
 * once the sandbox is handled — killed, or its id recorded in the orphan
 * ledger for retry; otherwise the row is retained to retry next pass.
 */
async function sweepDeletedConversations(
	options: CleanupPassOptions,
): Promise<Partial<CleanupSummary>> {
	const { db, workerId } = options;
	const orphaned = await db
		.select({
			userId: conversationRuntime.userId,
			conversationId: conversationRuntime.conversationId,
			sandboxId: conversationRuntime.sandboxId,
		})
		.from(conversationRuntime)
		.leftJoin(
			conversations,
			and(
				eq(conversations.userId, conversationRuntime.userId),
				eq(conversations.conversationId, conversationRuntime.conversationId),
			),
		)
		.where(isNull(conversations.conversationId));
	if (orphaned.length === 0) return {};

	let removed = 0;
	let retained = 0;
	for (const row of orphaned) {
		let handled = true;

		if (row.sandboxId !== null) {
			handled = await handleDeletedSandbox(options, row.sandboxId, {
				userId: row.userId,
				conversationId: row.conversationId,
				workerId,
			});
		}

		if (!handled) {
			retained++;
			continue;
		}
		// Retention is ours (ADR-0005): a deleted conversation's SDK transcripts go
		// with its runtime row. A pure DB delete (no external resource) with no FK
		// cascade to lean on, so it is done explicitly here, in the cleanup that
		// owns the conversation's other retained state.
		await deleteConversationAgentSessionsTx(db, {
			conversationId: row.conversationId,
		});
		await db
			.delete(conversationRuntime)
			.where(
				and(
					eq(conversationRuntime.userId, row.userId),
					eq(conversationRuntime.conversationId, row.conversationId),
				),
			);
		removed++;
	}
	return { deletedRuntimesRemoved: removed, deletedRuntimesRetained: retained };
}

/**
 * Handle the sandbox of a deleted conversation. A confirmed kill is enough; a
 * failed kill is delegated to the orphan ledger so the orphan sweep retries it,
 * which also lets the runtime pointer be cleared ("kill succeeds or records
 * retry state"). Only a failure to even record the orphan leaves the sandbox
 * unhandled, keeping the runtime row for a full retry.
 */
async function handleDeletedSandbox(
	options: CleanupPassOptions,
	sandboxId: string,
	owner: { userId: string; conversationId: string; workerId: string },
): Promise<boolean> {
	const { db, janitor, logger } = options;
	try {
		await janitor.killSandbox(sandboxId);
		return true;
	} catch (killError) {
		try {
			await db
				.insert(orphanSandboxes)
				.values({
					sandboxId,
					userId: owner.userId,
					conversationId: owner.conversationId,
					runId: CLEANUP_RUN_ID,
					createdByWorkerId: owner.workerId,
					reason: "conversation deleted; kill failed during cleanup",
				})
				.onConflictDoNothing();
			logger.warn({
				message: "deleted-conversation sandbox kill failed; recorded as orphan",
				sandboxId,
				conversationId: owner.conversationId,
				error: toMessage(killError),
			});
			return true;
		} catch (recordError) {
			logger.error({
				message:
					"deleted-conversation sandbox neither killed nor recorded; retaining row",
				sandboxId,
				conversationId: owner.conversationId,
				error: toMessage(recordError),
			});
			return false;
		}
	}
}

/** Sentinel `run_id` for orphan rows recorded by cleanup (there is no run). */
const CLEANUP_RUN_ID = "cleanup";

/** Sandbox ids named as the current pointer by any runtime row. */
async function referencedSandboxIds(db: Database): Promise<Set<string>> {
	const rows = await db
		.select({ sandboxId: conversationRuntime.sandboxId })
		.from(conversationRuntime)
		.where(isNotNull(conversationRuntime.sandboxId));
	const set = new Set<string>();
	for (const row of rows) if (row.sandboxId !== null) set.add(row.sandboxId);
	return set;
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
