/**
 * Daemon app factory. Wires the route modules into one Hono app from an injected
 * `DaemonConfig`, so the app is constructible without touching global env —
 * mirrors the gateway's `createGateway(config, db)`. Pure: config in, app out.
 * The entrypoint (`daemon-entry.ts`) is the only place that reads the env.
 */

import { Hono } from "hono";
import type { DaemonConfig } from "./config";
import { createCurrentRoutes } from "./routes/current";
import { createHealthRoutes } from "./routes/health";
import { createTurnRoutes } from "./routes/turn";

export function createDaemon(config: DaemonConfig): Hono {
	const app = new Hono();

	app.route("/", createHealthRoutes(config));
	app.route("/", createCurrentRoutes());
	app.route("/", createTurnRoutes(config));

	app.onError((err, c) => {
		console.error("Hono error:", err);
		return c.json(
			{ error: err instanceof Error ? err.message : String(err) },
			500,
		);
	});

	return app;
}
