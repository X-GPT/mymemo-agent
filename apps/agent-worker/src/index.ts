import { loadWorkerConfigFromEnv } from "./config/env";
import { startHealthServer } from "./health";
import { createLogger } from "./logger";
import { Worker } from "./worker";
import { generateWorkerId } from "./worker-id";

// Entrypoint: the only place that reads the environment. Boots the deployable
// skeleton — validated config, structured logger, worker id, a health endpoint,
// and graceful shutdown. The Postgres poll/claim loop is a later milestone
// (MYM-55); until then the worker boots, serves health, and drains cleanly.
const config = loadWorkerConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const workerId = generateWorkerId();

const worker = new Worker({
	workerId,
	maxConcurrentRuns: config.maxConcurrentRuns,
	shutdownTimeoutMs: config.shutdownTimeoutMs,
	logger,
});
const server = startHealthServer(worker, config.port, logger);

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
	await worker.shutdown();
	server.stop();
	logger.info({ message: "agent-worker stopped", workerId });
	process.exit(0);
}

process.on("SIGINT", (s) => void handleShutdownSignal(s));
process.on("SIGTERM", (s) => void handleShutdownSignal(s));
