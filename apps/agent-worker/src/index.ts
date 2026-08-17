import { createProductionAgentCoreDispatchPublisherLoop } from "./agentcore-dispatch/production";
import type { AdvisoryLockPool } from "./cleanup/advisory-lock";
import { CleanupLoop } from "./cleanup/cleanup-loop";
import { createS3ArtifactObjectJanitor } from "./cleanup/s3-artifact-janitor";
import {
	loadAgentCoreDispatchPublisherConfigFromEnv,
	loadWorkerConfigFromEnv,
} from "./config/env";
import { startHealthServer } from "./health";
import { createLogger } from "./logger";
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
const agentCoreDispatchConfig = loadAgentCoreDispatchPublisherConfigFromEnv(
	Bun.env,
);
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
// Worker-embedded external-resource cleanup (Task 8.1, ADR-0007/ADR-0011).
// Single-flighted across replicas by a Postgres advisory lock taken on a
// dedicated connection from Drizzle's underlying pg pool (`db.$client`). The
// The pass expires bounded Canary audit and reconciles E2B sandboxes and S3
// artifact objects from Postgres ledgers; it never lists either provider.
const cleanupLoop = new CleanupLoop({
	db,
	pool: db.$client as unknown as AdvisoryLockPool,
	sandboxJanitor,
	artifactJanitor: artifactObjectJanitor,
	workerId,
	intervalMs: config.cleanup.intervalMs,
	logger,
});
const agentCoreDispatchPublisherLoop =
	createProductionAgentCoreDispatchPublisherLoop({
		db,
		pool: db.$client as unknown as AdvisoryLockPool,
		workerId,
		awsRegion: config.artifact.region,
		config: agentCoreDispatchConfig,
		logger,
	});
const server = startHealthServer(worker, config.port, logger);

runLoop.start();
cleanupLoop.start();
agentCoreDispatchPublisherLoop.start();

logger.info({
	message: "agent-worker started",
	workerId,
	maxConcurrentConversations: config.maxConcurrentConversations,
	heartbeatIntervalMs: config.heartbeatIntervalMs,
});

let shuttingDown = false;
async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ message: "Received shutdown signal", signal, workerId });
	cleanupLoop.stop();
	await Promise.all([runLoop.stop(), agentCoreDispatchPublisherLoop.stop()]);
	await liveStreamRelay.close().catch(() => {});
	server.stop();
	logger.info({ message: "agent-worker stopped", workerId });
	process.exit(0);
}

process.on("SIGINT", (s) => void handleShutdownSignal(s));
process.on("SIGTERM", (s) => void handleShutdownSignal(s));
