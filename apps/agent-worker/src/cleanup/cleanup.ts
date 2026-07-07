import type { Database } from "@mymemo/agent-db/client";
import {
	conversationRuntime,
	conversations,
	orphanSandboxes,
} from "@mymemo/agent-db/schema";
import { and, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import type { WorkerLogger } from "../logger";

/**
 * Runtime hygiene for external E2B resources Postgres cannot delete
 * transactionally (design doc "Why Cleanup Exists", Task 8.1): orphaned
 * sandboxes, unreferenced snapshots past retention, and runtime rows for
 * deleted conversations/users. The database is the source of truth for what is
 * *referenced*; the janitor reconciles E2B against it. The one rule everything
 * here obeys: never kill a sandbox or snapshot still referenced by
 * `conversation_runtime`.
 *
 * The pass is deliberately unfenced (it runs when no run owns a conversation)
 * but conservative, idempotent, and per-row isolated: every E2B call is
 * idempotent (kill/delete of an already-gone resource resolves), a failing row
 * is left in place to retry on the next pass, and a failing sweep never aborts
 * the others — so cleanup can never block unrelated user runs.
 */

/**
 * The narrow E2B port cleanup needs, injected like the other executor tools'
 * sandbox clients (no concrete E2B wiring lives in worker production code yet).
 * Both operations must be idempotent: killing/deleting a resource that is
 * already gone resolves successfully; only a real, retryable failure rejects.
 */
export interface SandboxJanitor {
	/** Kill an E2B sandbox by id. Resolve if killed or already gone. */
	killSandbox(sandboxId: string): Promise<void>;
	/** Delete an E2B snapshot by id. Resolve if deleted or already gone. */
	deleteSnapshot(snapshotId: string): Promise<void>;
}

export interface CleanupConfig {
	/**
	 * Idle window before a conversation's superseded (`previous`) snapshot
	 * becomes eligible for deletion. Measured against `updated_at`, the last
	 * runtime mutation — an actively-used conversation bumps it and so is never a
	 * candidate. The spike's retention decision: days, not minutes.
	 */
	snapshotRetentionMs: number;
}

/** Per-pass tallies, returned for structured logging and asserted by tests. */
export interface CleanupSummary {
	orphanSandboxesKilled: number;
	orphanSandboxesFailed: number;
	orphanSandboxesSkippedReferenced: number;
	snapshotsDeleted: number;
	snapshotsFailed: number;
	deletedRuntimesRemoved: number;
	deletedRuntimesRetained: number;
}

export interface CleanupPassOptions {
	db: Database;
	janitor: SandboxJanitor;
	/** Records who recorded an orphan when a deleted-conversation kill fails. */
	workerId: string;
	config: CleanupConfig;
	logger: WorkerLogger;
	/** Injectable clock for deterministic retention tests; defaults to now. */
	now?: Date;
}

function zeroSummary(): CleanupSummary {
	return {
		orphanSandboxesKilled: 0,
		orphanSandboxesFailed: 0,
		orphanSandboxesSkippedReferenced: 0,
		snapshotsDeleted: 0,
		snapshotsFailed: 0,
		deletedRuntimesRemoved: 0,
		deletedRuntimesRetained: 0,
	};
}

/**
 * One cleanup pass: the three sweeps, each isolated so a whole-sweep failure
 * (e.g. a transient DB error) is logged and the remaining sweeps still run.
 * Returns the merged per-sweep tallies.
 */
export async function runCleanupPass(
	options: CleanupPassOptions,
): Promise<CleanupSummary> {
	const summary = zeroSummary();
	await runSweep(options.logger, "orphan-sandboxes", async () => {
		Object.assign(summary, await sweepOrphanSandboxes(options));
	});
	await runSweep(options.logger, "unreferenced-snapshots", async () => {
		Object.assign(summary, await sweepUnreferencedSnapshots(options));
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
 * Delete each conversation's superseded (`previous`) snapshot once the
 * conversation has been idle past the retention window, keeping `latest` (the
 * live restore path). A candidate is never deleted while its id is still a
 * restore path anywhere: any conversation's `latest`, or an unexpired `previous`
 * (guards E2B's repeating `templateId:tag` ids from cross-conversation
 * deletion). On success the column is cleared with a compare-and-set on the id,
 * so a concurrent run that rotated a fresh `previous` in is never clobbered.
 */
async function sweepUnreferencedSnapshots(
	options: CleanupPassOptions,
): Promise<Partial<CleanupSummary>> {
	const { db, janitor, logger } = options;
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - options.config.snapshotRetentionMs);

	const candidates = await db
		.select({
			userId: conversationRuntime.userId,
			conversationId: conversationRuntime.conversationId,
			previousSnapshotId: conversationRuntime.previousSnapshotId,
		})
		.from(conversationRuntime)
		.where(
			and(
				isNotNull(conversationRuntime.previousSnapshotId),
				lt(conversationRuntime.updatedAt, cutoff),
			),
		);
	if (candidates.length === 0) return {};

	const protectedIds = await protectedSnapshotIds(db, cutoff);
	let deleted = 0;
	let failed = 0;
	for (const candidate of candidates) {
		const snapshotId = candidate.previousSnapshotId;
		if (snapshotId === null || protectedIds.has(snapshotId)) continue;
		try {
			await janitor.deleteSnapshot(snapshotId);
		} catch (error) {
			failed++;
			logger.warn({
				message: "snapshot delete failed; will retry",
				snapshotId,
				error: toMessage(error),
			});
			continue;
		}
		// Compare-and-set on the id: if a run rotated a new `previous` in between
		// the select and here, that value differs and we leave it alone.
		await db
			.update(conversationRuntime)
			.set({ previousSnapshotId: null, updatedAt: new Date() })
			.where(
				and(
					eq(conversationRuntime.userId, candidate.userId),
					eq(conversationRuntime.conversationId, candidate.conversationId),
					eq(conversationRuntime.previousSnapshotId, snapshotId),
				),
			);
		deleted++;
	}
	return { snapshotsDeleted: deleted, snapshotsFailed: failed };
}

/**
 * Remove `conversation_runtime` rows whose conversation no longer exists (a
 * deleted conversation or user), killing the sandbox and deleting snapshots
 * first. The runtime row (and its pointers) is only removed once the sandbox is
 * handled — killed, or its id recorded in the orphan ledger for retry — and its
 * snapshots are deleted; otherwise the row is retained to retry next pass. A
 * snapshot still owned by a surviving conversation is left untouched.
 */
async function sweepDeletedConversations(
	options: CleanupPassOptions,
): Promise<Partial<CleanupSummary>> {
	const { db, janitor, logger, workerId } = options;
	const orphaned = await db
		.select({
			userId: conversationRuntime.userId,
			conversationId: conversationRuntime.conversationId,
			sandboxId: conversationRuntime.sandboxId,
			latestSnapshotId: conversationRuntime.latestSnapshotId,
			previousSnapshotId: conversationRuntime.previousSnapshotId,
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

	const liveReferenced = await liveReferencedSnapshotIds(db);
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

		for (const snapshotId of [row.latestSnapshotId, row.previousSnapshotId]) {
			if (snapshotId === null || liveReferenced.has(snapshotId)) continue;
			try {
				await janitor.deleteSnapshot(snapshotId);
			} catch (error) {
				handled = false;
				logger.warn({
					message: "deleted-conversation snapshot delete failed; will retry",
					snapshotId,
					conversationId: row.conversationId,
					error: toMessage(error),
				});
			}
		}

		if (!handled) {
			retained++;
			continue;
		}
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
	return toIdSet(rows.map((r) => r.sandboxId));
}

/**
 * Snapshot ids that are still a live restore path: any conversation's `latest`,
 * or a `previous` not yet past retention. A candidate matching one of these is
 * never deleted.
 */
async function protectedSnapshotIds(
	db: Database,
	cutoff: Date,
): Promise<Set<string>> {
	const latest = await db
		.select({ id: conversationRuntime.latestSnapshotId })
		.from(conversationRuntime)
		.where(isNotNull(conversationRuntime.latestSnapshotId));
	const unexpiredPrevious = await db
		.select({ id: conversationRuntime.previousSnapshotId })
		.from(conversationRuntime)
		.where(
			and(
				isNotNull(conversationRuntime.previousSnapshotId),
				gte(conversationRuntime.updatedAt, cutoff),
			),
		);
	return toIdSet([...latest, ...unexpiredPrevious].map((r) => r.id));
}

/** Snapshot ids (latest or previous) referenced by a still-existing conversation. */
async function liveReferencedSnapshotIds(db: Database): Promise<Set<string>> {
	const rows = await db
		.select({
			latest: conversationRuntime.latestSnapshotId,
			previous: conversationRuntime.previousSnapshotId,
		})
		.from(conversationRuntime)
		.innerJoin(
			conversations,
			and(
				eq(conversations.userId, conversationRuntime.userId),
				eq(conversations.conversationId, conversationRuntime.conversationId),
			),
		);
	return toIdSet(rows.flatMap((r) => [r.latest, r.previous]));
}

function toIdSet(ids: Array<string | null>): Set<string> {
	const set = new Set<string>();
	for (const id of ids) if (id !== null) set.add(id);
	return set;
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
