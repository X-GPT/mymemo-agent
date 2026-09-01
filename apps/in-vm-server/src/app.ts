import { Hono } from "hono";

/**
 * The In-VM server's HTTP surface (spec #654): nudge + health for callers, and
 * the platform's MicroVM lifecycle hooks (#666). Everything reaches this
 * listener through the platform's JWE-authenticated per-VM endpoint
 * (`X-aws-proxy-auth`) — the proxy is the authentication boundary, so the
 * routes themselves carry no auth.
 *
 * Nudge means "consult Postgres now" — the fire-and-forget `nudge` callback
 * starts draining if a Turn is queued and none is in flight; it carries no
 * message content and returns immediately, and idempotency lives in the DB's
 * one-in-flight claim gate, so any number of nudges are safe. Before the
 * `/run` hook configures the server it answers 503 — the platform holds
 * external traffic until `/run` returns 200, so a real caller can never see
 * that state.
 */

/** Base path the platform POSTs lifecycle hooks to (OpenAPI 2025-12-03). */
const HOOKS_BASE = "/aws/lambda-microvms/runtime/v1";

export interface AppHandlers {
	/** Fire-and-forget drain trigger. False = the server is not configured yet. */
	nudge: () => boolean;
	/**
	 * The `/run` lifecycle hook: configure the server for its Conversation from
	 * `runHookPayload`. The platform gates all endpoint traffic until this
	 * returns 200, so returning only after configuration (boot sweep included)
	 * is what makes "nudge before configured" unreachable from outside.
	 */
	run: (body: { microvmId?: string; runHookPayload?: string }) => Promise<void>;
	/**
	 * In-VM acceptance checks (`GET /smoke`, image runs only): the baked
	 * `smoke.sh` — bwrap namespaces, pinned versions, policy-tier ownership.
	 * Content-free diagnostics behind the JWE-authenticated endpoint; absent
	 * locally, where the route does not register.
	 */
	smokeScriptPath?: string;
}

export function createApp(handlers: AppHandlers) {
	const app = new Hono();

	app.post("/nudge", (c) =>
		handlers.nudge()
			? c.json({ status: "accepted" }, 202)
			: c.json({ error: "not configured" }, 503),
	);
	app.get("/health", (c) => c.json({ status: "ok" }));

	app.post(`${HOOKS_BASE}/run`, async (c) => {
		// A malformed body throws into Hono's 500 — the platform must see
		// non-200; payload validation lives in envFromRunHookPayload.
		await handlers.run(await c.req.json());
		return c.text("ok");
	});

	// ready gates the image build snapshot; resume/suspend/terminate bracket
	// the lifecycle. 200 = proceed. (validate is not enabled at registration —
	// see register_microvm_image.sh --hooks.) The graceful-drain suspend gate
	// and checkpointing land with the lifecycle ticket (#670) — until then the
	// snapshot itself preserves all state these hooks would flush.
	app.post(`${HOOKS_BASE}/:hook{ready|resume|suspend|terminate}`, (c) =>
		c.text("ok"),
	);

	if (handlers.smokeScriptPath) {
		const smokeScriptPath = handlers.smokeScriptPath;
		app.get("/smoke", async (c) => {
			const proc = Bun.spawn(["bash", smokeScriptPath], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return c.text(`${stdout}${stderr}\nEXIT ${exitCode}\n`);
		});
	}

	return app;
}
