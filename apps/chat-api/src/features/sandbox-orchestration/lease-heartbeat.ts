/**
 * Per-turn lease heartbeat. While a turn runs, this periodically renews the
 * conversation's ownership lease (and, on the same beat, the sandbox's E2B
 * timeout). One instance per in-flight turn, started in `acquire`, stopped in
 * `release`.
 *
 * Self-rescheduling `setTimeout` rather than `setInterval`, so a slow renew can
 * never overlap the next beat. The beat returns whether the hold is still ours:
 *  - `true`  → reschedule.
 *  - `false` → the lease was stolen (we stalled past its TTL); fire `onLost` to
 *    abort the turn and stop — two replicas must not write the same workspace.
 *
 * A transient renew error is NOT treated as "lost" (a one-off DB blip shouldn't
 * kill a healthy turn); it retries on the next beat, but only up to `maxErrors`
 * consecutive failures — beyond that the lease may genuinely have expired, so we
 * give up and abort.
 */
export class LeaseHeartbeat {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private consecutiveErrors = 0;

	constructor(
		/** One beat: renew the lease, returning false when the hold was lost. */
		private readonly beat: () => Promise<boolean>,
		/** Called once when the hold is lost (or renew keeps failing): abort the turn. */
		private readonly onLost: () => void,
		private readonly intervalMs: number,
		private readonly maxErrors = 3,
	) {}

	start(): void {
		if (this.timer || this.stopped) return;
		this.schedule();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private schedule(): void {
		this.timer = setTimeout(async () => {
			if (this.stopped) return;
			let held: boolean;
			try {
				held = await this.beat();
				this.consecutiveErrors = 0;
			} catch {
				// A transient failure isn't an authoritative loss — retry next beat,
				// unless we've failed enough that the lease has likely expired.
				this.consecutiveErrors++;
				held = this.consecutiveErrors < this.maxErrors;
			}
			if (this.stopped) return;
			if (!held) {
				this.onLost();
				return;
			}
			this.schedule();
		}, this.intervalMs);
		// Background maintenance — must not, on its own, keep the process alive.
		this.timer.unref?.();
	}
}
