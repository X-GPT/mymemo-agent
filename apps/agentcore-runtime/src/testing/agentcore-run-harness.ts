import type { Database } from "@mymemo/agent-db/client";
import { releaseConversationTx } from "@mymemo/agent-db/conversation-ownership";
import { loadExecutingRunTx } from "@mymemo/agent-db/run-store";
import { acquireQueuedRunForTest } from "@mymemo/agent-db/testing";
import type { LiveStreamRelay } from "@mymemo/live-text";
import type { RuntimeLogger } from "../logger";
import { createRunServing, type RunProcessor } from "../run-serving";

/** Test-only adapter that drives shared Run serving through AgentCore's exact
 * acquisition boundary without recreating the retired global Claim loop. */
export function createAgentCoreRunHarness(options: {
	db: Database;
	processor: RunProcessor;
	liveStreamRelay: LiveStreamRelay;
	logger: RuntimeLogger;
}) {
	const shutdown = new AbortController();
	const runServing = createRunServing(options);
	let activeRunServing: Promise<void> | null = null;

	async function executeNext(): Promise<void> {
		const owner = await acquireQueuedRunForTest(options.db, {
			workerId: "worker-1",
		});
		if (!owner) return;
		const run = await loadExecutingRunTx(options.db, owner);
		if (!run) throw new Error(`test Run ${owner.runId} was not executable`);
		const result = await runServing.serveStartedRun({
			run,
			owner,
			shutdownSignal: shutdown.signal,
		});
		if (result.type !== "ownership_lost") {
			await releaseConversationTx(options.db, owner);
		}
	}

	return {
		async tick(): Promise<void> {
			if (activeRunServing) {
				await runServing.heartbeat();
				return;
			}
			activeRunServing = executeNext().finally(() => {
				activeRunServing = null;
			});
			await Promise.resolve();
		},
		async drain(): Promise<void> {
			while (activeRunServing) await activeRunServing;
		},
		async stop(): Promise<void> {
			shutdown.abort(new Error("test Runtime stopped"));
			await this.drain();
		},
	};
}
