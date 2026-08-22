import { loadWorkerConfigFromEnv } from "agent-worker/config";
import { createLogger, toMessage } from "agent-worker/logger";
import { createProductionRunResources } from "agent-worker/production-run-resources";
import { createRunServing } from "agent-worker/run-serving";
import { createDatabaseAgentCoreAcquisitionBoundary } from "agentcore-dispatch-consumer/acquisition-boundary";
import { createAgentCoreExecutionServices } from "../src/execution-services";
import { createAgentCoreRuntime } from "../src/runtime";
import { startRuntimeServer } from "../src/server";

const config = loadWorkerConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const resources = createProductionRunResources({
	config,
	logger,
	processEnv: Bun.env,
	telemetryService: "agentcore-runtime",
});
const acquisition = createDatabaseAgentCoreAcquisitionBoundary({
	db: resources.db,
	bootId: `local/${crypto.randomUUID()}`,
	control: { isEnabled: async () => true },
});
const runServing = createRunServing({
	db: resources.db,
	processor: resources.processor,
	liveStreamRelay: resources.liveStreamRelay,
	liveStreamTelemetry: resources.liveStreamTelemetry,
	logger,
});
const runtime = createAgentCoreRuntime({
	...createAgentCoreExecutionServices({
		db: resources.db,
		acquire: acquisition.acquireDispatch,
		runServing,
		logger,
	}),
	heartbeatIntervalMs: config.heartbeatIntervalMs,
	onExecutionError(error, dispatch) {
		logger.error({
			message: "local AgentCore execution abandoned",
			conversationId: dispatch.conversationId,
			runId: dispatch.runId,
			error: toMessage(error),
		});
	},
});
const server = startRuntimeServer(runtime, config.port);

logger.info({ message: "local AgentCore Runtime started", port: config.port });
let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
	if (stopping) return;
	stopping = true;
	logger.info({ message: "local AgentCore Runtime stopping", signal });
	void server.stop(false);
	await runtime.shutdown(config.shutdownTimeoutMs);
	await resources.liveStreamRelay.close().catch(() => {});
	await resources.db.$client.end().catch(() => {});
	await server.stop(true);
	process.exit(0);
}
process.on("SIGINT", (signal) => void stop(signal));
process.on("SIGTERM", (signal) => void stop(signal));
