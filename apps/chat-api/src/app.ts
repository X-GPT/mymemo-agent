import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { pinoLogger } from "hono-pino";
import type { ApiConfig } from "./config/env";
import type { AppDeps, AppEnv } from "./deps";
import artifactRoutes from "./features/artifacts/artifacts.route";
import conversationHistoryRoutes from "./features/conversation-history/conversation-history.route";
import conversationLifecycleRoutes from "./features/conversations/conversation-lifecycle.route";
import conversationsRoutes from "./features/conversations/conversations.route";

/**
 * Build the app from a validated config. Dependencies are injectable so route
 * tests do not construct production database, AWS, Redis, or Statsig clients.
 */
export function createApp(config: ApiConfig, deps: AppDeps) {
	const app = new Hono<AppEnv>();
	app.use(requestId());
	app.use(pinoLogger({ pino: { level: config.logLevel } }));
	app.use((c, next) => {
		c.set("deps", deps);
		return next();
	});

	app.get("/", (c) => c.text("Hello Hono!"));
	app.get("/health", (c) => c.json({ status: "ok" }));
	app.route("/v1/conversations", conversationLifecycleRoutes);
	app.route("/v1/conversations", conversationsRoutes);
	app.route("/v1/conversations", conversationHistoryRoutes);
	app.route("/v1/conversations", artifactRoutes);

	return app;
}
