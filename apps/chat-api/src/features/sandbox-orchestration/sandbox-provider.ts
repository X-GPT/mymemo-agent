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

/** Where the turn proxy reaches the in-sandbox daemon, plus its auth token. */
export interface SandboxDaemonEndpoint {
	url: string;
	authToken: string;
}

export interface SandboxProvider {
	createSandbox(userId: string, logger: SyncLogger): Promise<SandboxHandle>;
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
