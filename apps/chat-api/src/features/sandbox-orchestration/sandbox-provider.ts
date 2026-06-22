/**
 * Sandbox provider seam. `runSandboxChat` drives a turn through three calls —
 * create a sandbox, ensure its daemon is reachable, tear it down — and treats
 * the handle as opaque (it only reads `sandboxId` and passes the handle back).
 *
 * Two implementations satisfy this:
 *   - E2BSandboxProvider        — production: a fresh per-turn E2B sandbox.
 *   - LocalContainerSandboxProvider — local E2E: a long-lived daemon container
 *     reached over the compose network (selected via SANDBOX_PROVIDER=local).
 *
 * The abstraction is intentionally small so the Milestone 5 leasing/provider
 * work can grow it without reshaping the orchestration call site.
 */

export interface SyncLogger {
	info(obj: Record<string, unknown>): void;
	error(obj: Record<string, unknown>): void;
}

/** Opaque per-turn sandbox handle. The orchestration only reads `sandboxId`. */
export interface SandboxHandle {
	sandboxId: string;
}

/** Where the turn proxy reaches the in-sandbox daemon. */
export interface SandboxDaemonEndpoint {
	url: string;
	/**
	 * Per-sandbox E2B traffic access token (sent as `e2b-traffic-access-token`).
	 * Present for the E2B provider, whose sandbox is created with
	 * `allowPublicTraffic: false` so its edge gates the public URL. Absent for the
	 * local provider, where the daemon container is unpublished on the compose
	 * network and there is no edge to authenticate against.
	 */
	trafficAccessToken?: string;
}

/**
 * Header name the E2B edge checks to admit a request to a sandbox's restricted
 * public URL. Vendor-controlled — keep it the single source of truth so the two
 * daemon callers (the turn proxy and the daemon health check) can't drift. Both
 * go through `trafficAccessHeaders`, so this stays module-private.
 */
const E2B_TRAFFIC_ACCESS_TOKEN_HEADER = "e2b-traffic-access-token";

/**
 * The `e2b-traffic-access-token` header for a daemon request, or an empty object
 * when there is no token (the local provider, which has no edge to authenticate
 * against). Spread into a `fetch` headers object.
 */
export function trafficAccessHeaders(
	token: string | undefined,
): Record<string, string> {
	return token ? { [E2B_TRAFFIC_ACCESS_TOKEN_HEADER]: token } : {};
}

export interface SandboxProvider {
	createSandbox(userId: string, logger: SyncLogger): Promise<SandboxHandle>;
	/**
	 * Reattach to an already-running sandbox by id. Leasing (Milestone 5) persists
	 * only a sandbox *id* — a live handle is an open network client that can't be
	 * serialized — so a process reusing a warm lease, or tearing down a lease it
	 * never created, reconstructs the handle here. Rejects if the sandbox no longer
	 * exists, which the lease manager treats as a stale lease and recreates.
	 */
	connectSandbox(sandboxId: string, logger: SyncLogger): Promise<SandboxHandle>;
	ensureSandboxDaemon(
		userId: string,
		handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<SandboxDaemonEndpoint>;
	killSandbox(
		userId: string,
		handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<void>;
	/**
	 * Best-effort cancellation hook for an in-flight turn. Idempotent and safe to
	 * call whether or not a turn is active, so a cancel signal that races a turn's
	 * completion never throws. The run-state cancellation contract ({@link Run.cancel})
	 * drives this; SSE wiring (Task 11) and leasing (Milestone 5) will invoke it.
	 * The per-turn providers have no in-place abort, so they honor it by tearing
	 * the sandbox down — which aborts the daemon turn.
	 */
	cancelSandbox(
		userId: string,
		handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<void>;
}
