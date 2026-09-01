import { Hono } from "hono";

/**
 * The In-VM server's HTTP surface (spec #654): nudge and health, nothing
 * else. Nudge means "consult Postgres now" — the fire-and-forget `nudge`
 * callback starts draining if a Turn is queued and none is in flight; it
 * carries no message content and returns immediately, and idempotency lives
 * in the DB's one-in-flight claim gate, so any number of nudges are safe.
 * Platform-authenticated inbound (JWE) arrives with #666; locally the
 * listener is plain HTTP.
 */
export function createApp(nudge: () => void) {
	const app = new Hono();
	app.post("/nudge", (c) => {
		nudge();
		return c.json({ status: "accepted" }, 202);
	});
	app.get("/health", (c) => c.json({ status: "ok" }));
	return app;
}
