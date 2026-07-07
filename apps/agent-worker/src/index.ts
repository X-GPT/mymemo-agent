import { createDatabase } from "@mymemo/agent-db/client";
import type { AdvisoryLockPool } from "./cleanup/advisory-lock";
import { CleanupLoop } from "./cleanup/cleanup-loop";
import { createE2bSandboxJanitor } from "./cleanup/e2b-janitor";
import { loadWorkerConfigFromEnv } from "./config/env";
import { startHealthServer } from "./health";
import { createLogger } from "./logger";
import { RunLoop } from "./run-loop";
import { syntheticProcessor } from "./synthetic-processor";
import { Worker } from "./worker";
import { generateWorkerId } from "./worker-id";

// Entrypoint: the only place that reads the environment. Boots the worker —
// validated config, structured logger, worker id, a health endpoint, the
// Postgres-backed claim/heartbeat/terminalize loop (Milestone 3), and graceful
// shutdown. Milestone 3 processes synthetic turns (one text event per run);
// the Claude Agent SDK loop replaces the processor in a later milestone.
const config = loadWorkerConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const workerId = generateWorkerId();

const worker = new Worker({
	workerId,
	maxConcurrentRuns: config.maxConcurrentRuns,
	shutdownTimeoutMs: config.shutdownTimeoutMs,
	logger,
});
const db = createDatabase(config.agentDatabaseUrl);
const runLoop = new RunLoop({
	db,
	worker,
	processor: syntheticProcessor,
	heartbeatIntervalMs: config.heartbeatIntervalMs,
	logger,
});
// Worker-embedded orphan/snapshot cleanup (Task 8.1). Single-flighted across
// replicas by a Postgres advisory lock taken on a dedicated connection from
// Drizzle's underlying pg pool (`db.$client`). The pass only calls E2B once
// real orphans/snapshots exist, so it is a no-op until the executor path is
// creating sandboxes.
const cleanupLoop = new CleanupLoop({
	db,
	pool: db.$client as unknown as AdvisoryLockPool,
	janitor: createE2bSandboxJanitor(config.e2bApiKey),
	workerId,
	config: { snapshotRetentionMs: config.cleanup.snapshotRetentionMs },
	intervalMs: config.cleanup.intervalMs,
	logger,
});
const server = startHealthServer(worker, config.port, logger);

runLoop.start();
cleanupLoop.start();

logger.info({
	message: "agent-worker started",
	workerId,
	maxConcurrentRuns: config.maxConcurrentRuns,
	heartbeatIntervalMs: config.heartbeatIntervalMs,
});

let shuttingDown = false;
async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ message: "Received shutdown signal", signal, workerId });
	cleanupLoop.stop();
	await runLoop.stop();
	server.stop();
	logger.info({ message: "agent-worker stopped", workerId });
	process.exit(0);
}

process.on("SIGINT", (s) => void handleShutdownSignal(s));
process.on("SIGTERM", (s) => void handleShutdownSignal(s));
