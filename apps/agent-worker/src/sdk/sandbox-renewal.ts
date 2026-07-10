/**
 * The per-run sandbox keep-alive (spec Milestone 9, Task 9.5): while a turn is
 * active, the provisioned sandbox's idle window must keep being extended or
 * E2B pauses the workspace mid-run. This timer calls `renew()` on a fixed
 * cadence tracked against the monotonic clock — each next fire is computed
 * from the previous *deadline*, not from when the timer happened to run, so a
 * late fire (busy event loop) does not push every later renewal further out.
 *
 * Renewal failure is terminal for the turn: the sandbox can no longer be
 * proven alive, so `onFailure` fires exactly once (the caller aborts the run's
 * linked controller — the run must end `error`, never `done`) and the timer
 * stops rather than re-extending a workspace it may have lost.
 */
export interface SandboxRenewalOptions {
	/** Extend the sandbox's idle window (the provisioned handle's `renew`). */
	renew(): Promise<void>;
	/** How often to renew; the caller derives it from the idle window. */
	intervalMs: number;
	/** Invoked once, with the renew error, when a renewal fails. */
	onFailure(error: unknown): void;
}

export interface SandboxRenewal {
	/** Stop renewing (the turn ended); the sandbox idle-pauses from here. */
	stop(): void;
}

export function startSandboxRenewal(
	opts: SandboxRenewalOptions,
): SandboxRenewal {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Monotonic deadline of the next renewal; advanced by exactly intervalMs
	// per fire so scheduling drift never accumulates.
	let nextDue = performance.now() + opts.intervalMs;

	const schedule = (): void => {
		if (stopped) return;
		timer = setTimeout(fire, Math.max(0, nextDue - performance.now()));
	};

	const fire = async (): Promise<void> => {
		if (stopped) return;
		try {
			await opts.renew();
		} catch (error) {
			stopped = true;
			opts.onFailure(error);
			return;
		}
		if (stopped) return; // stop() raced the in-flight renew
		nextDue += opts.intervalMs;
		schedule();
	};

	schedule();
	return {
		stop(): void {
			stopped = true;
			clearTimeout(timer);
		},
	};
}
