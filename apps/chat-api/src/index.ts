import { createLiveTextTelemetry } from "@mymemo/live-text";
import pino from "pino";
import { createApp } from "./app";
import { loadApiConfigFromEnv } from "./config/env";
import { createDeps } from "./deps";

export { createApp } from "./app";

// Entrypoint: the only place that reads the environment. `bun run src/index.ts`
// serves this default export. Redis remains lazy and optional; the signal hook
// only guarantees that any resources opened by active Live subscriptions are
// closed before the process exits.
const productionConfig = loadApiConfigFromEnv(Bun.env);
const productionLogger = pino({ level: productionConfig.logLevel });
const productionDeps = createDeps(
	productionConfig,
	createLiveTextTelemetry("chat-api", productionLogger),
);
const productionApp = createApp(productionConfig, productionDeps);
let shuttingDown = false;
async function closeProductionLiveText(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await productionDeps.closeLiveText?.().catch(() => {});
	productionDeps.liveTextTelemetry.close();
	process.exit(0);
}
process.once("SIGINT", () => void closeProductionLiveText());
process.once("SIGTERM", () => void closeProductionLiveText());

export default productionApp;
