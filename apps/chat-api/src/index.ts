import { createLiveStreamTelemetry } from "@mymemo/live-text";
import pino from "pino";
import { createApp } from "./app";
import { loadApiConfigFromEnv } from "./config/env";
import { createDeps } from "./deps";

export { createApp } from "./app";

// Entrypoint: the only place that reads the environment. `bun run src/index.ts`
// serves this default export. Redis construction is lazy: validated configuration
// is required at boot, while runtime reachability remains outside health.
const productionConfig = loadApiConfigFromEnv(Bun.env);
const productionLogger = pino({ level: productionConfig.logLevel });
const noHarness = () => {
	throw new Error("Harness chat is not enabled in production");
};
const productionDeps = createDeps(
	productionConfig,
	{ createHarnessChatAgent: noHarness, attachHarnessWorkspace: noHarness },
	createLiveStreamTelemetry("chat-api", productionLogger),
);
const productionApp = createApp(productionConfig, productionDeps);
let shuttingDown = false;
async function closeProductionLiveResources(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await productionDeps.closeLiveResources().catch(() => {});
	process.exit(0);
}
process.once("SIGINT", () => void closeProductionLiveResources());
process.once("SIGTERM", () => void closeProductionLiveResources());

export default productionApp;
