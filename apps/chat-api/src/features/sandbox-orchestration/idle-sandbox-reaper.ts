import type { SandboxLeaseManager } from "./sandbox-lease-manager";
import type { SyncLogger } from "./sandbox-provider";

/**
 * Periodic driver for the lease manager's idle-termination sweep (Task 14). The
 * sweep logic — which leases are idle, syncing before kill, skipping active runs
 * — lives in {@link SandboxLeaseManager.reapIdle}; this just calls it on an
 * interval and keeps one sweep from overlapping the next.
 *
 * Kept separate from the manager so the sweep stays a pure, clock-injected
 * function (deterministically testable without real timers) while the wall-clock
 * scheduling lives in one small, restartable place.
 */

/**
 * Default poll interval. Shorter than the idle window so an idle lease is reaped
 * within roughly one interval of crossing it, not a full window later.
 */
export const DEFAULT_REAP_INTERVAL_MS = 60_000;

/** The reaper depends only on the manager's sweep — narrowed for testability. */
type ReapableLeaseManager = Pick<SandboxLeaseManager, "reapIdle">;

export class IdleSandboxReaper {
	private timer: ReturnType<typeof setInterval> | null = null;
	/** True while a sweep is in flight, so a slow sweep can't overlap the next. */
	private sweeping = false;

	constructor(
		private readonly manager: ReapableLeaseManager,
		private readonly logger: SyncLogger,
		private readonly intervalMs: number = DEFAULT_REAP_INTERVAL_MS,
	) {}

	/** Begin sweeping on the interval. Idempotent — a second call is a no-op. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		// The reaper is background maintenance; it must not, on its own, keep the
		// process from exiting.
		this.timer.unref?.();
	}

	/** Stop sweeping. Idempotent and safe before `start`. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Run one sweep. Exposed for a deterministic test kick and a manual run. A
	 * sweep already in flight is skipped (a slow sweep must not pile up), and any
	 * thrown error is contained so the interval keeps ticking.
	 */
	async tick(): Promise<void> {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			await this.manager.reapIdle(this.logger);
		} catch (err) {
			this.logger.error({
				msg: "Idle reaper sweep failed",
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.sweeping = false;
		}
	}
}
