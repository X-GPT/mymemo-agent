import type { Database } from "@mymemo/agent-db/client";
import { RunFenceError } from "@mymemo/agent-db/run-store";
import {
	loadConversationRuntimeTx,
	markRuntimeCheckpointStatusTx,
	markRuntimeSandboxTaintedTx,
	type RunOwnershipRef,
	recordRuntimeSnapshotTx,
} from "@mymemo/agent-db/runtime-store";
import type { WorkerLogger } from "./logger";

/**
 * The E2B checkpoint capability the barrier needs, isolated behind a seam so
 * the terminal-success logic is tested without a live sandbox. `createSnapshot`
 * returns a reusable checkpoint id (design "Snapshot Policy"); the real
 * implementation is wired to the E2B client with the SDK loop in Milestone 7.
 */
export interface SnapshotSandbox {
	createSnapshot(): Promise<string>;
}

/**
 * What a processor reports back about the turn it just ran — the inputs the
 * snapshot barrier needs to decide the terminal. A `void`-returning processor
 * (the Milestone 3 synthetic turn) is normalized to a clean, sandbox-less
 * result: nothing to checkpoint.
 */
export interface TurnResult {
	/** Any `Write`/`Edit`/`Bash` succeeded, so the workspace holds user work
	 * newer than the latest snapshot and must be checkpointed before `done`. */
	workspaceDirty: boolean;
	/** The sandbox to checkpoint, or `null` when the turn touched no E2B
	 * workspace (synthetic turns, or turns that only searched documents). */
	sandbox: SnapshotSandbox | null;
	/** A worker-managed command was still executing when the turn returned. In
	 * v1 (foreground-only `Bash`) this should never happen; if it does, the
	 * sandbox cannot be proven clean and must not be snapshotted. */
	managedCommandRunning?: boolean;
	/**
	 * The agent session to record as the conversation's resume pointer once the
	 * turn terminalizes `done` (ADR-0005). Present only when the SDK produced a
	 * session id AND no `mirror_error` made the mirrored transcript unreliable —
	 * a dropped-mirror turn omits it, so the pointer does not advance yet the run
	 * still succeeds. Absent for synthetic / sandbox-less turns that ran no query.
	 */
	agentSession?: { sessionId: string } | null;
}

/**
 * The barrier's verdict for the run's terminal transition. `done`/`error` are
 * handed back for the caller to append through the run-store terminal helper
 * (which owns sequence allocation and the ownership fence); `abandon` means the
 * run must NOT be terminalized here — ownership was lost mid-barrier, so
 * stale-run recovery (or the new owner) produces the terminal event.
 */
export type BarrierDecision =
	| { terminal: "done" }
	| { terminal: "error"; message: string }
	| { abandon: true; reason: string };

export interface SnapshotBarrierInput {
	db: Database;
	owner: RunOwnershipRef;
	turnResult: TurnResult;
	logger: WorkerLogger;
}

/**
 * The checkpoint barrier a successful turn must clear before its run may
 * terminalize as `done` (design "Snapshot Policy"; plan Task 5.3). In order:
 *
 *  1. refuse if a managed command is still running — an unproven-clean sandbox
 *     is tainted and the run fails rather than snapshotting unstable files;
 *  2. snapshot the sandbox iff the workspace is dirty (a clean or sandbox-less
 *     turn needs no checkpoint), never snapshotting a sandbox already tainted
 *     by failed command cleanup;
 *  3. persist the new `snapshotId` under the ownership fence — a fence
 *     rejection here means ownership was lost, so the run is abandoned rather
 *     than reported `done`;
 *  4. return `done` for the caller to append the terminal event.
 *
 * Any snapshot-or-persist failure short of a fence loss becomes `error` and
 * marks the workspace `dirty_uncheckpointed`, so the last successful checkpoint
 * stays the recovery source of truth and the next turn re-checkpoints. The
 * barrier never emits a terminal event itself; it decides and performs the
 * pre-terminal side effects, and the caller owns the fenced terminal write —
 * which is where a late cancellation still wins over this success.
 */
export async function runSnapshotBarrier(
	input: SnapshotBarrierInput,
): Promise<BarrierDecision> {
	const { db, owner, turnResult, logger } = input;
	const { workspaceDirty, sandbox } = turnResult;

	// Step 1: no snapshot may start while a managed command is still running.
	// The sandbox cannot be proven clean, so taint it and fail — never `done`.
	if (turnResult.managedCommandRunning) {
		await bestEffortTaint(db, owner, logger);
		return {
			terminal: "error",
			message: "a worker-managed command was still running at turn end",
		};
	}

	// A turn that never stood up an E2B workspace has nothing to checkpoint.
	if (!sandbox) return { terminal: "done" };

	const runtime = await loadConversationRuntimeTx(db, {
		userId: owner.userId,
		conversationId: owner.conversationId,
	});

	// A sandbox tainted by failed command cleanup must never be snapshotted or
	// reported as a clean success (design: fail instead of checkpointing
	// potentially unstable files).
	if (runtime?.sandboxTainted) {
		return {
			terminal: "error",
			message:
				"sandbox is tainted by failed command cleanup; refusing to snapshot",
		};
	}

	if (workspaceDirty) {
		if (!runtime) {
			// A dirty workspace implies a sandbox, which implies a runtime row was
			// created at turn start. Its absence is an invariant break, not a lost
			// checkpoint — fail loudly rather than silently skip the snapshot.
			return {
				terminal: "error",
				message:
					"conversation runtime row is missing; cannot persist a snapshot",
			};
		}

		// Step 2: checkpoint the dirty workspace.
		let snapshotId: string;
		try {
			snapshotId = await sandbox.createSnapshot();
		} catch (error) {
			await bestEffortMarkDirty(db, owner, logger);
			return {
				terminal: "error",
				message: `snapshot creation failed: ${boundedMessage(error)}`,
			};
		}

		// Step 3: persist the checkpoint under the ownership fence.
		try {
			await recordRuntimeSnapshotTx(db, { ...owner, snapshotId });
		} catch (error) {
			if (error instanceof RunFenceError) {
				return {
					abandon: true,
					reason:
						"run ownership was lost while persisting the snapshot; " +
						"leaving the terminal event to stale-run recovery",
				};
			}
			await bestEffortMarkDirty(db, owner, logger);
			return {
				terminal: "error",
				message: `snapshot metadata persistence failed: ${boundedMessage(error)}`,
			};
		}
	}

	// Step 4: the workspace is checkpointed (or was clean) — the caller appends
	// `run_done`.
	return { terminal: "done" };
}

/**
 * Mark the workspace `dirty_uncheckpointed` so the next turn reconnects and
 * re-checkpoints. Best-effort: a fence loss here just means recovery already
 * owns the run, and any other error must not mask the original snapshot
 * failure the caller is already reporting as `error`.
 */
async function bestEffortMarkDirty(
	db: Database,
	owner: RunOwnershipRef,
	logger: WorkerLogger,
): Promise<void> {
	try {
		await markRuntimeCheckpointStatusTx(db, {
			...owner,
			status: "dirty_uncheckpointed",
		});
	} catch (error) {
		logger.warn({
			message:
				"could not mark workspace dirty_uncheckpointed after snapshot failure",
			runId: owner.runId,
			error: boundedMessage(error),
		});
	}
}

/**
 * Taint the sandbox so it is not reused or snapshotted until cleanup proves it
 * clean. Best-effort: if the fence rejects, ownership is already lost and the
 * error decision the caller returns cannot become a bogus terminal anyway.
 */
async function bestEffortTaint(
	db: Database,
	owner: RunOwnershipRef,
	logger: WorkerLogger,
): Promise<void> {
	try {
		await markRuntimeSandboxTaintedTx(db, owner);
	} catch (error) {
		logger.warn({
			message:
				"could not taint sandbox after detecting a running managed command",
			runId: owner.runId,
			error: boundedMessage(error),
		});
	}
}

function boundedMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}
