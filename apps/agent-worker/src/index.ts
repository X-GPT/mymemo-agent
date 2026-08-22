import type { AdvisoryLockPool } from "./cleanup/advisory-lock";
import { createS3ArtifactObjectJanitor } from "./cleanup/s3-artifact-janitor";
import { loadWorkerConfigFromEnv } from "./config/env";
import { startHealthServer } from "./health";
import { createLogger } from "./logger";
import { MaintenanceRunner } from "./maintenance-runner";
import { createProductionRunResources } from "./production-run-resources";
import { PostgresRunDoorbell } from "./run-doorbell";
import { RunLoop } from "./run-loop";
import { Worker } from "./worker";
import { generateWorkerId } from "./worker-id";

// Entrypoint: the only place that reads the environment. Boots the worker —
// validated config, structured logger, worker id, a health endpoint, the
// Postgres-backed Claim/renew/terminalize loop, the real Claude Agent SDK
// processor over E2B, and graceful shutdown.
const config = loadWorkerConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const workerId = generateWorkerId();
const worker = new Worker({
	workerId,
	maxConcurrentConversations: config.maxConcurrentConversations,
	shutdownTimeoutMs: config.shutdownTimeoutMs,
	logger,
});
const { db, processor, liveStreamRelay, liveStreamTelemetry, sandboxJanitor } =
	createProductionRunResources({ config, logger });
const artifactObjectJanitor = createS3ArtifactObjectJanitor(config.artifact);
const runLoop = new RunLoop({
	db,
	worker,
	processor,
	liveStreamRelay,
	liveStreamTelemetry,
	heartbeatIntervalMs: config.heartbeatIntervalMs,
	// Admission commits and `running` → `interrupt_requested` transitions ring
	// this doorbell (the migration-0012 `run_doorbell` triggers), so pickup and
	// stop latency are milliseconds instead of a poll interval; the timer tick
	// above remains the source of truth if the LISTEN connection drops.
	doorbell: new PostgresRunDoorbell(config.agentDatabaseUrl, logger),
	logger,
});
// Global expiration, Reclamation, and external-resource cleanup are isolated
// from Run serving behind the maintenance runner. Cleanup remains
// single-flighted across replicas by a Postgres advisory lock.
const maintenanceRunner = new MaintenanceRunner({
	db,
	pool: db.$client as unknown as AdvisoryLockPool,
	sandboxJanitor,
	artifactJanitor: artifactObjectJanitor,
	workerId,
	cleanupIntervalMs: config.cleanup.intervalMs,
	logger,
	liveStreamTelemetry,
});
const server = startHealthServer(worker, config.port, logger);

let shuttingDown = false;
void maintenanceRunner.start().then(() => {
	if (!shuttingDown) runLoop.start();
});

logger.info({
	message: "agent-worker started",
	workerId,
	maxConcurrentConversations: config.maxConcurrentConversations,
	heartbeatIntervalMs: config.heartbeatIntervalMs,
});

async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ message: "Received shutdown signal", signal, workerId });
	maintenanceRunner.stop();
	await runLoop.stop();
	await liveStreamRelay.close().catch(() => {});
	server.stop();
	logger.info({ message: "agent-worker stopped", workerId });
	process.exit(0);
}

process.on("SIGINT", (s) => void handleShutdownSignal(s));
process.on("SIGTERM", (s) => void handleShutdownSignal(s));
