import { describe, expect, it } from "bun:test";
import {
	type AdvisoryLockClient,
	type AdvisoryLockPool,
	tryWithAdvisoryLock,
} from "./advisory-lock";
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
			on() {},
			off() {},
			release() {},
		};
	}
}

class ControllableLockPool implements AdvisoryLockPool {
	private errorListener: ((error: Error) => void) | undefined;
	readonly releasedWith: Array<Error | boolean | undefined> = [];

	async connect(): Promise<AdvisoryLockClient> {
		return {
			query: async (text: string) =>
				text.includes("pg_try_advisory_lock")
					? { rows: [{ locked: true }] }
					: { rows: [] },
			on: (_event, listener) => {
				this.errorListener = listener;
			},
			off: (_event, listener) => {
				if (this.errorListener === listener) this.errorListener = undefined;
			},
			release: (error) => {
				this.releasedWith.push(error);
			},
		};
	}

	fail(error: Error): void {
		this.errorListener?.(error);
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
			{ outcome: "lock_not_acquired", PublisherLockNotAcquired: 1 },
		]);
	});

	it("runs the complete publisher tick while holding the lock", async () => {
		const events: string[] = [];
		await expect(
			publishAgentCoreDispatchTick({
				pool: {
					async connect() {
						events.push("connect");
						return {
							async query(text: string) {
								events.push(
									text.includes("pg_try_advisory_lock") ? "lock" : "unlock",
								);
								return text.includes("pg_try_advisory_lock")
									? { rows: [{ locked: true }] }
									: { rows: [] };
							},
							on() {},
							off() {},
							release() {
								events.push("release");
							},
						};
					},
				},
				publisher: {
					publishPending: async () => {
						events.push("publish");
					},
				},
				logger: new RecordingLogger(),
			}),
		).resolves.toBeUndefined();

		expect(events).toEqual(["connect", "lock", "publish", "unlock", "release"]);
	});
});

describe("tryWithAdvisoryLock", () => {
	it("unlocks the session before returning it after callback failure", async () => {
		const queries: string[] = [];
		const releasedWith: Array<Error | boolean | undefined> = [];
		const callbackFailure = new Error("publish failed");
		const pool: AdvisoryLockPool = {
			async connect() {
				return {
					async query(text) {
						queries.push(text);
						return text.includes("pg_try_advisory_lock")
							? { rows: [{ locked: true }] }
							: { rows: [] };
					},
					on() {},
					off() {},
					release(error) {
						releasedWith.push(error);
					},
				};
			},
		};

		await expect(
			tryWithAdvisoryLock(pool, 42, async () => {
				throw callbackFailure;
			}),
		).rejects.toBe(callbackFailure);

		expect(queries).toEqual([
			"select pg_try_advisory_lock($1) as locked",
			"select pg_advisory_unlock($1)",
		]);
		expect(releasedWith).toEqual([undefined]);
	});
});

describe("runAgentCoreDispatchPublisher", () => {
	it("records a lock-session failure and continues on a fresh connection", async () => {
		const shutdown = new AbortController();
		const logger = new RecordingLogger();
		const pool = new ControllableLockPool();
		const connectionFailure = new Error("lock connection terminated");
		let publishCalls = 0;

		await runAgentCoreDispatchPublisher({
			pool,
			publisher: {
				publishPending: async (lockSignal) => {
					publishCalls += 1;
					if (publishCalls === 1) {
						pool.fail(connectionFailure);
						expect(lockSignal.aborted).toBe(true);
					}
				},
			},
			intervalMs: 2_000,
			signal: shutdown.signal,
			wait: async () => {
				if (publishCalls === 2) shutdown.abort();
			},
			logger,
		});

		expect(publishCalls).toBe(2);
		expect(pool.releasedWith).toEqual([connectionFailure, undefined]);
		expect(logger.errorRecords).toMatchObject([
			{
				reason: "tick_failed",
				error: "lock connection terminated",
				PublisherErrors: 1,
			},
		]);
	});

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

	it("records the sampled pending age from a failed publication", async () => {
		const shutdown = new AbortController();
		const logger = new RecordingLogger();
		await runAgentCoreDispatchPublisher({
			pool: new FakeLockPool(true),
			publisher: {
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
