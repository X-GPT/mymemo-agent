/**
 * Test-only run-event writer for the credential-free Postgres integration.
 * Production never imports this file: the real agent-worker entrypoint always
 * runs the Claude Agent SDK. This fixture keeps the queue → durable run event →
 * chat-api projector seam deterministic; Task 9.7 owns the credentialed live
 * smoke for the production worker.
 */
import { createLogger } from "../apps/agent-worker/src/logger";
import { RunLoop, type RunProcessor } from "../apps/agent-worker/src/run-loop";
import { Worker } from "../apps/agent-worker/src/worker";
import { createDatabase } from "../packages/agent-db/src/client";

const agentDatabaseUrl = process.env.AGENT_DATABASE_URL;
if (!agentDatabaseUrl) throw new Error("AGENT_DATABASE_URL is required");

const logger = createLogger(process.env.LOG_LEVEL ?? "warn");
const workerId = "integration-event-writer";
const worker = new Worker({
	workerId,
	maxConcurrentRuns: 1,
	shutdownTimeoutMs: 1_000,
	logger,
});
const processor: RunProcessor = async (ctx) => {
	await ctx.appendModelContent({
		kind: "assistant_message",
		payload: {
			messageId: `message-${ctx.run.runId}`,
			text: `Synthetic response for run ${ctx.run.runId}`,
		},
	});
};
const runLoop = new RunLoop({
	db: createDatabase(agentDatabaseUrl),
	worker,
	processor,
	heartbeatIntervalMs: 500,
	logger,
});

runLoop.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await runLoop.stop();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
