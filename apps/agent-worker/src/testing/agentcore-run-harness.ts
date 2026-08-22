import type { Database } from "@mymemo/agent-db/client";
import { releaseConversationTx } from "@mymemo/agent-db/conversation-ownership";
import { loadExecutingRunTx } from "@mymemo/agent-db/run-store";
import { runs } from "@mymemo/agent-db/schema";
import { acquireQueuedRunForTest } from "@mymemo/agent-db/testing";
import type { LiveStreamRelay } from "@mymemo/live-text";
import { eq } from "drizzle-orm";
import type { WorkerLogger } from "../logger";
import { createRunServing, type RunProcessor } from "../run-serving";

/** Test-only adapter that drives shared Run serving through AgentCore's exact
 * acquisition boundary without recreating the retired Fargate Claim loop. */
export function createAgentCoreRunHarness(options: {
	db: Database;
	processor: RunProcessor;
	liveStreamRelay: LiveStreamRelay;
	logger: WorkerLogger;
	workerId?: string;
}) {
	const shutdown = new AbortController();
	const runServing = createRunServing(options);
	let task: Promise<void> | null = null;

	async function executeNext(): Promise<void> {
		const [queued] = await options.db
			.select()
			.from(runs)
			.where(eq(runs.status, "queued"))
			.orderBy(runs.createdAt, runs.runId)
			.limit(1);
		if (!queued) return;

		const workerId = options.workerId ?? "worker-1";
		const acquired = await acquireQueuedRunForTest(options.db, {
			workerId,
			runId: queued.runId,
		});
		if (!acquired) throw new Error(`test Run ${queued.runId} was not acquired`);
		const owner = { ...acquired, runId: queued.runId, workerId };
		const run = await loadExecutingRunTx(options.db, owner);
		if (!run) throw new Error(`test Run ${queued.runId} was not executable`);
		try {
			await runServing.serveStartedRun({
				run,
				owner,
				shutdownSignal: shutdown.signal,
			});
		} finally {
			await releaseConversationTx(options.db, acquired);
		}
	}

	return {
		async tick(): Promise<void> {
			if (task) {
				await runServing.heartbeat();
				return;
			}
			task = executeNext().finally(() => {
				task = null;
			});
			await Promise.resolve();
		},
		async drain(): Promise<void> {
			while (task) await task;
		},
		async stop(): Promise<void> {
			shutdown.abort(new Error("test Runtime stopped"));
			await this.drain();
		},
	};
}
