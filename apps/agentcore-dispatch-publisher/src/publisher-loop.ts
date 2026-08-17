import { setTimeout as sleep } from "node:timers/promises";
import { type AdvisoryLockPool, tryWithAdvisoryLock } from "./advisory-lock";
import type { PublisherLogger } from "./logger";
import {
	recordPublisherLockNotAcquired,
	recordPublisherTickFailure,
} from "./publisher-metrics";
import { PublisherTickFailure } from "./publisher-tick-failure";

export const PUBLISHER_ADVISORY_LOCK_KEY = 8_242_869_154_306_403;

export interface AgentCoreDispatchPublisher {
	isEnabled(): Promise<boolean>;
	publishPending(): Promise<void>;
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
	if (options.signal?.aborted || !(await options.publisher.isEnabled())) return;
	if (options.signal?.aborted) return;
	const locked = await tryWithAdvisoryLock(
		options.pool,
		PUBLISHER_ADVISORY_LOCK_KEY,
		() => options.publisher.publishPending(),
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
