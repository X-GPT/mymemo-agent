import type { ApiConfig } from "@/config/env";
import type {
	SandboxDaemonEndpoint,
	SandboxHandle,
	SandboxProvider,
	SyncLogger,
} from "./sandbox-provider";

const LOCAL_SANDBOX_ID = "local-sandbox";
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_HEALTH_CHECK_INTERVAL_MS = 500;

/**
 * Local E2E provider: instead of leasing a fresh E2B sandbox per turn, it points
 * at a single long-lived daemon container reached over the compose network
 * (LOCAL_SANDBOX_DAEMON_URL, e.g. http://sandbox:8080). The daemon + agent
 * bundles and the `claude`/`mymemo-docs` binaries are baked into that image, so
 * `createSandbox` returns a static handle, `ensureSandboxDaemon` only waits for
 * `/health` (nothing to deploy), and `killSandbox` is a no-op (the container
 * outlives the turn). The single-turn lock in the daemon serializes concurrent
 * turns — fine for a test harness; see MYM-31 for the prod divergence.
 */
export interface LocalContainerSandboxProviderOptions {
	/** Max time to wait for the daemon to report healthy (default 30s). */
	readyTimeoutMs?: number;
	/** Poll interval while waiting (default 500ms). */
	pollIntervalMs?: number;
}

export class LocalContainerSandboxProvider implements SandboxProvider {
	private readonly readyTimeoutMs: number;
	private readonly pollIntervalMs: number;

	// Timeouts are injectable so tests can exercise the unhealthy/throw path
	// without waiting the real 30s; production uses the defaults.
	constructor(
		private readonly config: ApiConfig,
		opts: LocalContainerSandboxProviderOptions = {},
	) {
		this.readyTimeoutMs = opts.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS;
		this.pollIntervalMs =
			opts.pollIntervalMs ?? DAEMON_HEALTH_CHECK_INTERVAL_MS;
	}

	async createSandbox(
		userId: string,
		logger: SyncLogger,
	): Promise<SandboxHandle> {
		logger.info({
			msg: "Using local sandbox container",
			userId,
			daemonUrl: this.config.localSandboxDaemonUrl,
		});
		return { sandboxId: LOCAL_SANDBOX_ID };
	}

	async ensureSandboxDaemon(
		userId: string,
		_handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<SandboxDaemonEndpoint> {
		const url = this.config.localSandboxDaemonUrl;
		// No edge to authenticate against: the daemon container is unpublished on
		// the compose network, so the turn proxy sends no traffic token.
		const endpoint = { url };

		// Bundles are baked into the image, so there is nothing to push — just wait
		// for the container's daemon to accept connections.
		const deadline = Date.now() + this.readyTimeoutMs;
		while (Date.now() < deadline) {
			if (await this.isHealthy(url)) {
				logger.info({
					msg: "Local sandbox daemon is ready",
					userId,
					daemonUrl: url,
				});
				return endpoint;
			}
			await new Promise((r) => setTimeout(r, this.pollIntervalMs));
		}
		throw new Error(
			`Local sandbox daemon at ${url} did not become healthy within ${this.readyTimeoutMs}ms`,
		);
	}

	async killSandbox(): Promise<void> {
		// The local container is long-lived — nothing to tear down per turn.
	}

	async cancelSandbox(
		userId: string,
		handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<void> {
		// The shared container is long-lived and has no per-turn abort hook, so
		// cancellation is a best-effort no-op here; the daemon's turn lock frees
		// when the turn ends. Mirrors killSandbox.
		logger.info({
			msg: "Local sandbox cancel is a no-op",
			userId,
			sandboxId: handle.sandboxId,
		});
	}

	private async isHealthy(url: string): Promise<boolean> {
		try {
			const response = await fetch(`${url}/health`, {
				signal: AbortSignal.timeout(3_000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}
