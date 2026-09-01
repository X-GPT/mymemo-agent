import { sweepStaleProcessingTurnsTx } from "@mymemo/agent-db/turn-store";
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
 */

const SELF_HEAL_INTERVAL_MS = 15_000;

export interface DrainLoopHandle {
	/** The doorbell: fire-and-forget "consult Postgres now". Always safe. */
	nudge(): void;
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

	const nudge = (): void => {
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
			let outcome: Awaited<ReturnType<typeof serveOneTurn>> = null;
			try {
				outcome = await serveOneTurn(deps);
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
			await sleep();
		}
	})();

	return {
		nudge,
		async stop() {
			stopped = true;
			nudge();
			await running;
		},
	};
}
