import { describe, expect, it } from "bun:test";
import type { AdvisoryLockClient, AdvisoryLockPool } from "./advisory-lock";
import type { PublisherLogger } from "./logger";
import {
	publishAgentCoreDispatchTick,
	runAgentCoreDispatchPublisher,
} from "./publisher-loop";
import { PublisherTickFailure } from "./publisher-tick-failure";

class FakeLockPool implements AdvisoryLockPool {
	constructor(private readonly locked: boolean) {}

	async connect(): Promise<AdvisoryLockClient> {
		const locked = this.locked;
		return {
			async query(text: string) {
				return text.includes("pg_try_advisory_lock")
					? { rows: [{ locked }] }
					: { rows: [] };
			},
			release() {},
		};
	}
}

class RecordingLogger implements PublisherLogger {
	readonly infoRecords: Record<string, unknown>[] = [];
	readonly errorRecords: Record<string, unknown>[] = [];

	info(record: Record<string, unknown>): void {
		this.infoRecords.push(record);
	}
	error(record: Record<string, unknown>): void {
		this.errorRecords.push(record);
	}
}

describe("publishAgentCoreDispatchTick", () => {
	it("makes the old task a no-op during deployment overlap", async () => {
		const logger = new RecordingLogger();
		let publishCalls = 0;
		await expect(
			publishAgentCoreDispatchTick({
				pool: new FakeLockPool(false),
				publisher: {
					isEnabled: async () => true,
					async publishPending() {
						publishCalls += 1;
					},
				},
				logger,
			}),
		).resolves.toBeUndefined();

		expect(publishCalls).toBe(0);
		expect(logger.infoRecords).toMatchObject([
			{ outcome: "lock_not_acquired", PublisherLockNotAcquired: 1 },
		]);
	});

	it("checks the fail-closed gate before opening a lock connection", async () => {
		let connectCalls = 0;
		let publishCalls = 0;
		await expect(
			publishAgentCoreDispatchTick({
				pool: {
					async connect() {
						connectCalls += 1;
						throw new Error("lock must not be attempted");
					},
				},
				publisher: {
					isEnabled: async () => false,
					publishPending: async () => {
						publishCalls += 1;
					},
				},
				logger: new RecordingLogger(),
			}),
		).resolves.toBeUndefined();

		expect(connectCalls).toBe(0);
		expect(publishCalls).toBe(0);
	});

	it("publishes once while holding the lock", async () => {
		let publishCalls = 0;
		await expect(
			publishAgentCoreDispatchTick({
				pool: new FakeLockPool(true),
				publisher: {
					isEnabled: async () => true,
					async publishPending() {
						publishCalls += 1;
					},
				},
				logger: new RecordingLogger(),
			}),
		).resolves.toBeUndefined();

		expect(publishCalls).toBe(1);
	});
});

describe("runAgentCoreDispatchPublisher", () => {
	it("continues after a failed tick and stops on abort", async () => {
		const shutdown = new AbortController();
		const logger = new RecordingLogger();
		let publishCalls = 0;
		let waits = 0;
		await runAgentCoreDispatchPublisher({
			pool: new FakeLockPool(true),
			publisher: {
				isEnabled: async () => true,
				publishPending: async () => {
					publishCalls += 1;
					if (publishCalls === 1) throw new Error("SSM unavailable");
				},
			},
			intervalMs: 2_000,
			signal: shutdown.signal,
			wait: async () => {
				waits += 1;
				if (waits === 2) shutdown.abort();
			},
			logger,
		});

		expect(publishCalls).toBe(2);
		expect(logger.errorRecords).toMatchObject([
			{ reason: "tick_failed", error: "SSM unavailable", PublisherErrors: 1 },
		]);
	});

	it("records the sampled pending age from a failed publication", async () => {
		const shutdown = new AbortController();
		const logger = new RecordingLogger();
		await runAgentCoreDispatchPublisher({
			pool: new FakeLockPool(true),
			publisher: {
				isEnabled: async () => true,
				publishPending: async () => {
					throw new PublisherTickFailure(new Error("SSM unavailable"), 5_000);
				},
			},
			intervalMs: 2_000,
			signal: shutdown.signal,
			wait: async () => shutdown.abort(),
			logger,
		});

		expect(logger.errorRecords).toMatchObject([
			{
				reason: "tick_failed",
				error: "SSM unavailable",
				PendingAgeMs: 5_000,
				PublisherErrors: 1,
			},
		]);
	});
});
