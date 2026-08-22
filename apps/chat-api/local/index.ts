import { createLiveStreamTelemetry } from "@mymemo/live-text";
import pino from "pino";
import { createApp } from "../src/app";
import { loadApiConfigFromEnv } from "../src/config/env";
import { createDeps } from "../src/deps";

const config = loadApiConfigFromEnv({
	...Bun.env,
	STATSIG_SERVER_SECRET: "unused-by-local-composition",
});
const logger = pino({ level: config.logLevel });
const deps = createDeps(config, createLiveStreamTelemetry("chat-api", logger), {
	isAgentEnabled: async () => true,
});
let shuttingDown = false;
async function close(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await deps.closeLiveResources().catch(() => {});
	process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

export default createApp(config, deps);
