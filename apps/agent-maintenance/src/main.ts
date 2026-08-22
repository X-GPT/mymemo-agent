import { createDatabase } from "@mymemo/agent-db/client";
import type { AdvisoryLockPool } from "agent-worker/advisory-lock";
import { createE2bSandboxJanitor } from "agent-worker/e2b-janitor";
import { createLogger } from "agent-worker/logger";
import { MaintenanceRunner } from "agent-worker/maintenance-runner";
import { createS3ArtifactObjectJanitor } from "agent-worker/s3-artifact-janitor";
import { loadMaintenanceConfigFromEnv } from "./config";
import { startMaintenanceService } from "./service";

interface MaintenancePool extends AdvisoryLockPool {
	end(): Promise<void>;
}

const config = loadMaintenanceConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const maintenanceId = `maintenance/${crypto.randomUUID()}`;
const db = createDatabase(config.agentDatabaseUrl);
const pool = db.$client as unknown as MaintenancePool;
const runner = new MaintenanceRunner({
	db,
	pool,
	sandboxJanitor: createE2bSandboxJanitor(config.e2bApiKey),
	artifactJanitor: createS3ArtifactObjectJanitor(config.artifact),
	workerId: maintenanceId,
	cleanupIntervalMs: config.cleanupIntervalMs,
	logger,
});
const service = await startMaintenanceService({
	runner,
	port: config.port,
	logger,
});

logger.info({ message: "agent-maintenance started", maintenanceId });

let shuttingDown = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ message: "Received shutdown signal", signal, maintenanceId });
	await service.stop();
	await pool.end();
	logger.info({ message: "agent-maintenance stopped", maintenanceId });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void stop(signal));
}
