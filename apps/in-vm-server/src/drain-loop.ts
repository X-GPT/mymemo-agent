import {
	cancelQueuedTurnTx,
	sweepStaleProcessingTurnsTx,
} from "@mymemo/agent-db/turn-store";
import { serveOneTurn, type TurnServingDeps } from "./turn-serving";

/**
 * The Conversation's drain loop (spec #654, ticket #664) — the feeder side of
 * feeder/consumer. One task claims and serves queued Turns strictly in
 * sequence order; one-in-flight is gated by the DB itself (`claimNextTurnTx`
 * refuses while anything is `processing`). When the queue is empty the task
 * parks on a wakeable sleep: a nudge rings the doorbell for an immediate
 * re-check (a nudge arriving mid-Turn is kept and consulted right after the
 * terminal), and the interval tick self-heals a lost nudge. A Turn's `error`
 * Outcome never wedges the loop — the next claim proceeds regardless.
 *
 * On start the loop boot-sweeps stale `processing` rows to `interrupted`
 * (a Turn is never re-run) and then claims immediately, so a restart with
 * queued rows resumes draining without a nudge.
 *
 * The suspend hook's graceful-drain gate (#670) is `pause`: no new claim
 * while paused, and the promise settles once the loop is parked with nothing
 * in flight — the moment the Checkpoint may be taken. `resume` (the resume
 * hook) lifts it.
 */

const SELF_HEAL_INTERVAL_MS = 15_000;

export interface DrainLoopHandle {
	/** The doorbell: fire-and-forget "consult Postgres now". Always safe. */
	nudge(): void;
	/** The nudge's one command (#668) — see "Interrupt a v2 Turn" in
	 * docs/agents/chat-api.md. Rejects only when the queued-cancel itself
	 * failed, so the nudge answers non-2xx instead of claiming it applied. */
	interrupt(messageId: string): Promise<void>;
	/** Hold claims; settles once the loop is parked with nothing in flight
	 * (after `resume`, once the queue drains). Reentrant. */
	pause(): Promise<void>;
	/** Lift `pause` and consult Postgres again. Idempotent. */
	resume(): void;
	/** Whether a nudge arrived since `pause` — work the parked loop is
	 * holding back. */
	nudgedWhilePaused(): boolean;
	/** Stop after the Turn in flight (if any) completes. */
	stop(): Promise<void>;
}

export function startDrainLoop(
	deps: TurnServingDeps & { selfHealIntervalMs?: number },
): DrainLoopHandle {
	const intervalMs = deps.selfHealIntervalMs ?? SELF_HEAL_INTERVAL_MS;
	const conversationKey = {
		userId: deps.userId,
		conversationId: deps.conversationId,
	};
	let doorbell = false;
	let wake: (() => void) | null = null;
	let stopped = false;
	let paused = false;
	let nudgedWhilePaused = false;
	// The pause() caller, released when the loop parks idle (or stops).
	let parked: { settled: Promise<void>; release: () => void } | null = null;
	const releaseParked = (): void => {
		parked?.release();
		parked = null;
	};
	// The in-flight Turn's interrupt channel (serveOneTurn listens for the
	// life of its claim).
	const interrupts = new EventTarget();

	const nudge = (): void => {
		if (paused) nudgedWhilePaused = true;
		doorbell = true;
		wake?.();
		wake = null;
	};

	// The wakeable sleep. The doorbell check and the wake installation share
	// one synchronous executor, so a nudge can never fall between them.
	const sleep = (): Promise<void> =>
		new Promise((resolve) => {
			if (doorbell || stopped) return resolve();
			const timer = setTimeout(() => {
				wake = null;
				resolve();
			}, intervalMs);
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});

	const running = (async () => {
		// Boot sweep, retried on the sleep cadence until it lands — claiming is
		// gated on nothing `processing`, so draining cannot start ahead of it.
		while (!stopped) {
			doorbell = false;
			try {
				const swept = await sweepStaleProcessingTurnsTx(
					deps.db,
					conversationKey,
				);
				if (swept.length > 0) {
					deps.logger.warn(
						{ ...conversationKey, messageIds: swept },
						"boot sweep terminalized stale processing Turns as interrupted",
					);
				}
				break;
			} catch (error) {
				deps.logger.error(
					{ ...conversationKey, error: String(error) },
					"boot sweep failed; retrying",
				);
				await sleep();
			}
		}

		while (!stopped) {
			doorbell = false;
			if (paused) {
				// Parked with nothing in flight: the Checkpoint is consistent now.
				releaseParked();
				await sleep();
				continue;
			}
			let outcome: Awaited<ReturnType<typeof serveOneTurn>> = null;
			try {
				outcome = await serveOneTurn(deps, interrupts);
			} catch (error) {
				// serveOneTurn terminalizes its own Turn failures; only a claim
				// that never got off the ground (a DB blip) lands here. Sleep
				// and let the interval retry it.
				deps.logger.error(
					{ ...conversationKey, error: String(error) },
					"serveOneTurn failed; drain loop continues",
				);
			}
			// A served Turn (any Outcome) means the queue may hold more; a
			// doorbell rung mid-Turn means the same. Re-check immediately.
			if (outcome !== null || doorbell) continue;
			// Idle: a pause outlived by resume settles here, once the queue drained.
			releaseParked();
			await sleep();
		}
		releaseParked();
	})();

	return {
		nudge,
		async interrupt(messageId) {
			const turnKey = { ...conversationKey, messageId };
			// Queued-cancel first: it is the DB that says whether the claim
			// already happened, and the in-flight check below catches a target
			// claimed while this cancel was refused.
			if (await cancelQueuedTurnTx(deps.db, turnKey)) {
				deps.logger.warn(
					turnKey,
					"interrupt reached a still-queued Turn; interrupted without running",
				);
			} else if (deps.currentTurn.turnId === messageId) {
				interrupts.dispatchEvent(new Event("interrupt"));
			} else {
				deps.logger.warn(
					turnKey,
					"interrupt target is neither queued nor in flight; dropped",
				);
			}
		},
		pause() {
			paused = true;
			if (!parked) {
				let release: () => void = () => {};
				const settled = new Promise<void>((resolve) => {
					release = resolve;
				});
				parked = { settled, release };
				// Wake a parked loop so it re-parks as paused and releases us.
				nudge();
			}
			// Only nudges from here on count as held-back work.
			nudgedWhilePaused = false;
			return parked.settled;
		},
		resume() {
			paused = false;
			nudge();
		},
		nudgedWhilePaused: () => nudgedWhilePaused,
		async stop() {
			stopped = true;
			nudge();
			await running;
		},
	};
}
