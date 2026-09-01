import { Hono } from "hono";

/**
 * The In-VM server's HTTP surface (spec #654): nudge and health, nothing
 * else. Nudge means "consult Postgres now" — it carries no message content
 * and returns immediately; idempotency lives in the DB's one-in-flight claim
 * gate, so any number of nudges are safe. Platform-authenticated inbound
 * (JWE) arrives with #666; locally the listener is plain HTTP.
 */
export interface AppDeps {
	/** Fire-and-forget: start draining if a Turn is queued and none is in flight. */
	nudge(): void;
}

export function createApp(deps: AppDeps) {
	const app = new Hono();
	app.post("/nudge", (c) => {
		deps.nudge();
		return c.json({ status: "accepted" }, 202);
	});
	app.get("/health", (c) => c.json({ status: "ok" }));
	return app;
}
