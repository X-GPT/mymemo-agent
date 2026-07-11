import { createLiveTextTelemetry } from "@mymemo/live-text";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { pinoLogger } from "hono-pino";
import pino from "pino";
import { type ApiConfig, loadApiConfigFromEnv } from "./config/env";
import { type AppDeps, type AppEnv, createDeps } from "./deps";
import routes from "./routes";

/**
 * Build the app from a validated config. The composition root: it constructs
 * `AppDeps` once and injects them into every request via `c.var.deps`, so no
 * downstream module reads global env. Mirrors the gateway's `createGateway`.
 */
export function createApp(
	config: ApiConfig,
	deps: AppDeps = createDeps(config),
) {
	const app = new Hono<AppEnv>();
	app.use(requestId());
	app.use(pinoLogger({ pino: { level: config.logLevel } }));
	app.use((c, next) => {
		c.set("deps", deps);
		return next();
	});

	app.get("/", (c) => c.text("Hello Hono!"));
	app.get("/health", (c) => c.json({ status: "ok" }));

	app.route("/", routes);

	return app;
}

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
