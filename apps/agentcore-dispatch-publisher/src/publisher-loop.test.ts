import { describe, expect, it } from "bun:test";
import type { AdvisoryLockClient, AdvisoryLockPool } from "./advisory-lock";
import type { PublisherLogger } from "./logger";
import {
	publishAgentCoreDispatchTick,
	runAgentCoreDispatchPublisher,
} from "./publisher-loop";

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
					async publishPending() {
						publishCalls += 1;
					},
				},
				logger,
			}),
		).resolves.toBeUndefined();

		expect(publishCalls).toBe(0);
		expect(logger.infoRecords).toMatchObject([
			{ outcome: "lost_lock", PublisherLostLock: 1 },
		]);
	});

	it("publishes once while holding the lock", async () => {
		let publishCalls = 0;
		await expect(
			publishAgentCoreDispatchTick({
				pool: new FakeLockPool(true),
				publisher: {
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
});
