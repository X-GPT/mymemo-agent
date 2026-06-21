import { resolve } from "node:path";
import { Sandbox } from "e2b";
import type { ApiConfig } from "@/config/env";
import { SandboxCreationError } from "./errors";
import type {
	SandboxDaemonEndpoint,
	SandboxHandle,
	SandboxProvider,
	SyncLogger,
} from "./sandbox-provider";

const DAEMON_PORT = 8080;
const DAEMON_STARTUP_TIMEOUT_MS = 15_000;
const DAEMON_HEALTH_CHECK_INTERVAL_MS = 500;

// Two separate bundles deployed into the sandbox. Versioned together by the
// hash of both concatenated — any change to either triggers a daemon restart.
// The daemon spawns agent.js per turn; only the daemon bundle is long-running.
const DAEMON_BUNDLE = {
	name: "daemon",
	sandboxPath: "/workspace/daemon.js",
	distFile: "daemon.js",
} as const;
const AGENT_BUNDLE = {
	name: "agent",
	sandboxPath: "/workspace/agent.js",
	distFile: "agent.js",
} as const;
const SANDBOX_BUNDLES = [DAEMON_BUNDLE, AGENT_BUNDLE] as const;
const DAEMON_BUNDLE_PATH = DAEMON_BUNDLE.sandboxPath;
const DIST_DIR = resolve(
	import.meta.dirname,
	"../../../../sandbox-daemon/dist",
);

interface SandboxBundleSet {
	files: Array<{ sandboxPath: string; code: string }>;
	version: string;
}

let bundlePromise: Promise<SandboxBundleSet> | null = null;

function getSandboxBundles(): Promise<SandboxBundleSet> {
	if (!bundlePromise) bundlePromise = loadSandboxBundles();
	return bundlePromise;
}

async function loadSandboxBundles(): Promise<SandboxBundleSet> {
	const files: SandboxBundleSet["files"] = [];
	const hasher = new Bun.CryptoHasher("sha256");
	for (const { name, sandboxPath, distFile } of SANDBOX_BUNDLES) {
		const path = `${DIST_DIR}/${distFile}`;
		let code: string;
		try {
			code = await Bun.file(path).text();
		} catch (err) {
			throw new Error(
				`Prebuilt ${name} bundle missing at ${path}. Run \`bun run build:daemon\` from apps/chat-api.`,
				{ cause: err },
			);
		}
		hasher.update(code);
		files.push({ sandboxPath, code });
	}
	const version = hasher.digest("hex").slice(0, 12);
	return { files, version };
}

/**
 * Production provider: a fresh per-turn E2B sandbox. `createSandbox` returns the
 * live E2B `Sandbox` (it satisfies `SandboxHandle`); `ensureSandboxDaemon` pushes
 * the daemon + agent bundles and waits for `/health`; `killSandbox` tears it down.
 */
export class E2BSandboxProvider implements SandboxProvider {
	constructor(private readonly config: ApiConfig) {}

	async createSandbox(
		userId: string,
		logger: SyncLogger,
	): Promise<SandboxHandle> {
		logger.info({ msg: "Creating sandbox", userId });

		try {
			const sandbox = await Sandbox.create(this.config.e2bTemplate, {
				metadata: { userId },
			});

			logger.info({
				msg: "Sandbox created",
				userId,
				sandboxId: sandbox.sandboxId,
			});

			return sandbox;
		} catch (err) {
			throw new SandboxCreationError(
				`Failed to create sandbox for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async killSandbox(
		userId: string,
		handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<void> {
		// Safe: the provider is singleton-selected per process, so the handle is
		// always the E2B Sandbox this provider's createSandbox returned.
		const sandbox = handle as Sandbox;
		try {
			await sandbox.kill();
		} catch (err) {
			logger.error({
				msg: "Failed to kill sandbox",
				userId,
				sandboxId: sandbox.sandboxId,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		logger.info({
			msg: "Sandbox killed",
			userId,
			sandboxId: sandbox.sandboxId,
		});
	}

	/**
	 * Cancel an in-flight turn. A per-turn E2B sandbox has no in-place turn abort,
	 * so killing the sandbox is the cancellation. `killSandbox` already swallows
	 * errors, so this is idempotent and safe whether or not a turn is in flight.
	 */
	async cancelSandbox(
		userId: string,
		handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<void> {
		logger.info({
			msg: "Canceling sandbox turn",
			userId,
			sandboxId: handle.sandboxId,
		});
		await this.killSandbox(userId, handle, logger);
	}

	/**
	 * Deploy the daemon + agent bundles onto the freshly created sandbox and
	 * wait for the daemon to report healthy. Returns the daemon URL and the
	 * fixed auth token clients must present.
	 *
	 * Sandboxes are created fresh per turn, so the daemon is never already
	 * running — there is nothing to health-check or restart, only to deploy.
	 */
	async ensureSandboxDaemon(
		userId: string,
		handle: SandboxHandle,
		logger: SyncLogger,
	): Promise<SandboxDaemonEndpoint> {
		// Safe: see killSandbox — the singleton provider only ever receives the
		// Sandbox its own createSandbox returned.
		const sandbox = handle as Sandbox;
		const daemonUrl = this.getDaemonUrl(sandbox);
		const endpoint = { url: daemonUrl, authToken: this.config.daemonAuthToken };

		const bundles = await getSandboxBundles();

		logger.info({
			msg: "Deploying sandbox daemon",
			userId,
			sandboxId: sandbox.sandboxId,
		});

		await this.deploySandboxBundles(sandbox, logger, bundles);
		return endpoint;
	}

	getDaemonUrl(sandbox: Sandbox): string {
		return `https://${sandbox.getHost(DAEMON_PORT)}`;
	}

	private async checkDaemonHealth(
		daemonUrl: string,
	): Promise<{ status: string; version: string; uptime: number } | null> {
		try {
			const response = await fetch(`${daemonUrl}/health`, {
				signal: AbortSignal.timeout(3_000),
			});
			if (!response.ok) return null;
			const body = (await response.json()) as {
				status: string;
				version: string;
				uptime: number;
			};
			return body;
		} catch {
			return null;
		}
	}

	private async deploySandboxBundles(
		sandbox: Sandbox,
		logger: SyncLogger,
		bundles: SandboxBundleSet,
	): Promise<void> {
		await sandbox.files.write(
			bundles.files.map(({ sandboxPath, code }) => ({
				path: sandboxPath,
				data: code,
			})),
		);

		await this.startDaemonProcess(sandbox, logger, bundles.version);
	}

	private async startDaemonProcess(
		sandbox: Sandbox,
		logger: SyncLogger,
		expectedVersion: string,
	): Promise<void> {
		await sandbox.commands.run(
			`bun ${DAEMON_BUNDLE_PATH} >> /workspace/daemon.log 2>&1`,
			{
				background: true,
				envs: {
					DAEMON_VERSION: expectedVersion,
					DAEMON_AUTH_TOKEN: this.config.daemonAuthToken,
				},
			},
		);

		const daemonUrl = this.getDaemonUrl(sandbox);
		const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;

		while (Date.now() < deadline) {
			const health = await this.checkDaemonHealth(daemonUrl);
			if (health && (!expectedVersion || health.version === expectedVersion)) {
				logger.info({
					msg: "Sandbox daemon is ready",
					version: health.version,
				});
				return;
			}
			await new Promise((r) => setTimeout(r, DAEMON_HEALTH_CHECK_INTERVAL_MS));
		}

		throw new Error("Daemon failed to start within timeout");
	}
}
