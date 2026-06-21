import { Hono } from "hono";
import type { DaemonConfig } from "../config";

/**
 * /health route factory. The version is injected from config (DAEMON_VERSION),
 * surfaced for the chat-api bundle check. `startTime` is captured when the
 * factory runs — once, at daemon startup — so uptime measures process lifetime.
 */
export function createHealthRoutes(config: DaemonConfig): Hono {
	const app = new Hono();
	const startTime = Date.now();

	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			version: config.daemonVersion,
			uptime: Math.floor((Date.now() - startTime) / 1000),
		});
	});

	return app;
}
