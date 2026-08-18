import { setTimeout as sleep } from "node:timers/promises";
import { type AdvisoryLockPool, tryWithAdvisoryLock } from "./advisory-lock";
import type { PublisherLogger } from "./logger";
import {
	recordPublisherLockNotAcquired,
	recordPublisherPublication,
	recordPublisherTickFailure,
} from "./publisher-metrics";
import { PublisherTickFailure } from "./publisher-tick-failure";

export const PUBLISHER_ADVISORY_LOCK_KEY = 8_242_869_154_306_403;

export interface AgentCoreDispatchPublisher {
	isEnabled(): Promise<boolean>;
	loadPendingAgeMs(): Promise<number>;
	publishPending(lockSignal: AbortSignal): Promise<void>;
}

interface PublisherTickOptions {
	pool: AdvisoryLockPool;
	publisher: AgentCoreDispatchPublisher;
	logger: PublisherLogger;
	signal?: AbortSignal;
}

interface PublisherLoopOptions extends PublisherTickOptions {
	intervalMs: number;
	signal: AbortSignal;
	wait?: (intervalMs: number, signal: AbortSignal) => Promise<void>;
}

/** Publish one batch while this task owns the deployment-overlap lock. */
export async function publishAgentCoreDispatchTick(
	options: PublisherTickOptions,
): Promise<void> {
	if (options.signal?.aborted) return;
	const enabled = await options.publisher.isEnabled();
	if (options.signal?.aborted) return;
	if (!enabled) {
		const pendingAgeMs = await options.publisher.loadPendingAgeMs();
		if (options.signal?.aborted) return;
		recordPublisherPublication(
			options.logger,
			{ status: "disabled", ambiguousRunIds: [] },
			pendingAgeMs,
		);
		return;
	}
	const locked = await tryWithAdvisoryLock(
		options.pool,
		PUBLISHER_ADVISORY_LOCK_KEY,
		(lockSignal) => options.publisher.publishPending(lockSignal),
	);
	if (!locked.ran) recordPublisherLockNotAcquired(options.logger);
}

async function waitForNextTick(
	intervalMs: number,
	signal: AbortSignal,
): Promise<void> {
	try {
		await sleep(intervalMs, undefined, { signal });
	} catch (error) {
		if (!signal.aborted) throw error;
	}
}

/** Run until ECS sends SIGTERM or SIGINT. */
export async function runAgentCoreDispatchPublisher(
	options: PublisherLoopOptions,
): Promise<void> {
	const wait = options.wait ?? waitForNextTick;
	while (!options.signal.aborted) {
		try {
			await publishAgentCoreDispatchTick(options);
		} catch (error) {
			recordPublisherTickFailure(
				options.logger,
				error instanceof PublisherTickFailure ? error.failure : error,
				error instanceof PublisherTickFailure ? error.pendingAgeMs : undefined,
			);
		}
		if (!options.signal.aborted) {
			await wait(options.intervalMs, options.signal);
		}
	}
}
