import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { pinoLogger } from "hono-pino";
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
// serves this default export.
export default createApp(loadApiConfigFromEnv(Bun.env));
