import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { pinoLogger } from "hono-pino";
import type { ApiConfig } from "./config/env";
import { type AppDeps, type AppEnv, createDeps } from "./deps";
import routes from "./routes";

/**
 * Build the app from a validated config. Dependencies are injectable so route
 * tests do not construct production database, AWS, Redis, or Statsig clients.
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
