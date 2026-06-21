import { Hono } from "hono";
import { getCurrentTurn } from "../turn-lock";

/**
 * /current route factory. Reports the daemon's single-turn lock state. Takes no
 * config — kept a factory for parity with the other route modules so
 * `createDaemon` wires them uniformly.
 */
export function createCurrentRoutes(): Hono {
	const app = new Hono();

	app.get("/current", (c) => {
		const { busy, turnId } = getCurrentTurn();
		return c.json({ busy, turnId });
	});

	return app;
}
