import { createProductionCanaryRuntimeFromEnv } from "./production";
import { startRuntimeServer } from "./server";

const production = await createProductionCanaryRuntimeFromEnv(Bun.env);
const server = startRuntimeServer(
	production.runtime,
	production.bootstrap.port,
);

production.logger.info({
	message: "AgentCore canary Runtime started",
	port: production.bootstrap.port,
});

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
	if (stopping) return;
	stopping = true;
	production.logger.info({
		message: "AgentCore canary Runtime stopping",
		signal,
	});
	const drain = production.runtime.shutdown(
		production.bootstrap.shutdownTimeoutMs,
	);
	void server.stop(false);
	await drain;
	await production.close();
	await server.stop(true);
	production.logger.info({ message: "AgentCore canary Runtime stopped" });
	process.exit(0);
}

process.on("SIGINT", (signal) => void stop(signal));
process.on("SIGTERM", (signal) => void stop(signal));
