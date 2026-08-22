import { createDatabase } from "@mymemo/agent-db/client";
import type { AdvisoryLockPool } from "agent-worker/advisory-lock";
import { createE2bSandboxJanitor } from "agent-worker/e2b-janitor";
import { createLogger } from "agent-worker/logger";
import { MaintenanceRunner } from "agent-worker/maintenance-runner";
import { createS3ArtifactObjectJanitor } from "agent-worker/s3-artifact-janitor";
import { loadMaintenanceConfigFromEnv } from "./config";

const config = loadMaintenanceConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const maintenanceId = `maintenance/${crypto.randomUUID()}`;
const db = createDatabase(config.agentDatabaseUrl);
const pool = db.$client as unknown as AdvisoryLockPool & {
	end(): Promise<void>;
};
const runner = new MaintenanceRunner({
	db,
	pool,
	sandboxJanitor: createE2bSandboxJanitor(config.e2bApiKey),
	artifactJanitor: createS3ArtifactObjectJanitor(config.artifact),
	workerId: maintenanceId,
	cleanupIntervalMs: 300_000,
	logger,
});
await runner.start();
const server = Bun.serve({
	port: config.port,
	fetch(request) {
		if (new URL(request.url).pathname === "/health") {
			return Response.json({ status: "ok", service: "agent-maintenance" });
		}
		return new Response("not found", { status: 404 });
	},
});
logger.info({
	message: "agent-maintenance health server listening",
	port: config.port,
});

logger.info({ message: "agent-maintenance started", maintenanceId });

let shuttingDown = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ message: "Received shutdown signal", signal, maintenanceId });
	runner.stop();
	server.stop();
	await pool.end();
	logger.info({ message: "agent-maintenance stopped", maintenanceId });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void stop(signal));
}
