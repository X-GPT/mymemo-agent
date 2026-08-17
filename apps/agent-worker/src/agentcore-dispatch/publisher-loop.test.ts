import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import { createCanaryDispatchPublisher } from "agentcore-canary-dispatch/publisher";
import type {
	AdvisoryLockClient,
	AdvisoryLockPool,
} from "../cleanup/advisory-lock";
import type { WorkerLogger } from "../logger";
import { AgentCoreDispatchPublisherLoop } from "./publisher-loop";

const dispatch: AgentCoreDispatchIdentity = {
	schemaVersion: 2,
	userId: "user-481",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-481",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	admittedAt: new Date("2026-08-17T12:00:00.000Z"),
};

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

class TrackingGrantedLockPool implements AdvisoryLockPool {
	unlocks = 0;
	releases = 0;

	async connect(): Promise<AdvisoryLockClient> {
		return {
			query: async (text: string) => {
				if (text.includes("pg_try_advisory_lock")) {
					return { rows: [{ locked: true }] };
				}
				if (text.includes("pg_advisory_unlock")) this.unlocks += 1;
				return { rows: [] };
			},
			release: () => {
				this.releases += 1;
			},
		};
	}
}

class RecordingLogger implements WorkerLogger {
	readonly infoRecords: Record<string, unknown>[] = [];
	readonly warnRecords: Record<string, unknown>[] = [];
	readonly errorRecords: Record<string, unknown>[] = [];

	info(record: Record<string, unknown>): void {
		this.infoRecords.push(record);
	}
	warn(record: Record<string, unknown>): void {
		this.warnRecords.push(record);
	}
	error(record: Record<string, unknown>): void {
		this.errorRecords.push(record);
	}
}

describe("AgentCoreDispatchPublisherLoop.runOnce", () => {
	it("makes a losing replica a no-op and records the lost-lock metric", async () => {
		const logger = new RecordingLogger();
		let publishCalls = 0;
		const loop = new AgentCoreDispatchPublisherLoop({
			pool: new FakeLockPool(false),
			publisher: {
				async publishPending() {
					publishCalls += 1;
					return {
						status: "enabled" as const,
						publishedRunIds: [],
						ambiguousRunIds: [],
					};
				},
			},
			pendingStore: {
				oldestUnpublishedAdmittedAt: async () => null,
			},
			intervalMs: 2_000,
			logger,
		});

		await expect(loop.runOnce()).resolves.toEqual({ outcome: "lost_lock" });
		expect(publishCalls).toBe(0);
		expect(logger.infoRecords).toMatchObject([
			{
				message: "AgentCore dispatch publisher metric",
				outcome: "lost_lock",
				PublisherLostLock: 1,
				_aws: {
					CloudWatchMetrics: [
						{
							Namespace: "MyMemo/AgentCoreDispatch",
							Metrics: [{ Name: "PublisherLostLock", Unit: "Count" }],
						},
					],
				},
			},
		]);
	});

	it("publishes nothing behind the disabled gate and records pending age", async () => {
		const logger = new RecordingLogger();
		const calls: string[] = [];
		const loop = new AgentCoreDispatchPublisherLoop({
			pool: new FakeLockPool(true),
			publisher: createCanaryDispatchPublisher({
				publisherId: "worker-1",
				control: {
					isEnabled: async () => {
						calls.push("control");
						return false;
					},
				},
				store: {
					claim: async () => {
						calls.push("claim");
						return [];
					},
					confirm: async () => {
						calls.push("confirm");
						return true;
					},
				},
				queue: {
					send: async () => {
						calls.push("send");
					},
				},
			}),
			pendingStore: {
				oldestUnpublishedAdmittedAt: async () =>
					new Date("2026-08-17T12:00:00.000Z"),
			},
			intervalMs: 2_000,
			now: () => new Date("2026-08-17T12:00:05.000Z"),
			logger,
		});

		await expect(loop.runOnce()).resolves.toEqual({
			outcome: "disabled",
			pendingAgeMs: 5_000,
		});
		expect(calls).toEqual(["control"]);
		expect(logger.infoRecords).toMatchObject([
			{
				message: "AgentCore dispatch publisher metric",
				outcome: "disabled",
				PendingAgeMs: 5_000,
				_aws: {
					CloudWatchMetrics: [
						{
							Namespace: "MyMemo/AgentCoreDispatch",
							Metrics: [{ Name: "PendingAgeMs", Unit: "Milliseconds" }],
						},
					],
				},
			},
		]);
	});

	it("records an ambiguous send as an error without marking the row", async () => {
		const logger = new RecordingLogger();
		let confirmed = false;
		const loop = new AgentCoreDispatchPublisherLoop({
			pool: new FakeLockPool(true),
			publisher: createCanaryDispatchPublisher({
				publisherId: "worker-1",
				control: { isEnabled: async () => true },
				store: {
					claim: async () => [dispatch],
					confirm: async () => {
						confirmed = true;
						return true;
					},
				},
				queue: {
					send: async () => {
						throw new Error("connection closed after send");
					},
				},
			}),
			pendingStore: {
				oldestUnpublishedAdmittedAt: async () => dispatch.admittedAt,
			},
			intervalMs: 2_000,
			now: () => new Date("2026-08-17T12:00:05.000Z"),
			logger,
		});

		await expect(loop.runOnce()).resolves.toEqual({
			outcome: "error",
			pendingAgeMs: 5_000,
		});
		expect(confirmed).toBe(false);
		expect(logger.errorRecords).toMatchObject([
			{
				message: "AgentCore dispatch publisher metric",
				outcome: "error",
				reason: "ambiguous_send",
				ambiguousCount: 1,
				PendingAgeMs: 5_000,
				PublisherErrors: 1,
				_aws: {
					CloudWatchMetrics: [
						{
							Namespace: "MyMemo/AgentCoreDispatch",
							Metrics: [
								{ Name: "PublisherErrors", Unit: "Count" },
								{ Name: "PendingAgeMs", Unit: "Milliseconds" },
							],
						},
					],
				},
			},
		]);
	});

	it("fails closed for a tick error and stays available for the next tick", async () => {
		const logger = new RecordingLogger();
		let attempts = 0;
		const loop = new AgentCoreDispatchPublisherLoop({
			pool: new FakeLockPool(true),
			publisher: {
				publishPending: async () => {
					attempts += 1;
					if (attempts === 1) throw new Error("SSM unavailable");
					return {
						status: "enabled",
						publishedRunIds: [],
						ambiguousRunIds: [],
					};
				},
			},
			pendingStore: {
				oldestUnpublishedAdmittedAt: async () => dispatch.admittedAt,
			},
			intervalMs: 2_000,
			now: () => new Date("2026-08-17T12:00:05.000Z"),
			logger,
		});

		await expect(loop.runOnce()).resolves.toEqual({
			outcome: "error",
			pendingAgeMs: 5_000,
		});
		expect(logger.errorRecords).toMatchObject([
			{
				message: "AgentCore dispatch publisher metric",
				outcome: "error",
				reason: "tick_failed",
				error: "SSM unavailable",
				PendingAgeMs: 5_000,
				PublisherErrors: 1,
			},
		]);
		await expect(loop.runOnce()).resolves.toEqual({
			outcome: "published",
			pendingAgeMs: 5_000,
		});
	});
});

describe("AgentCoreDispatchPublisherLoop lifecycle", () => {
	it("does not add a full interval after a slow tick", async () => {
		let publishCalls = 0;
		let firstTickStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			firstTickStarted = resolve;
		});
		let finishFirstTick!: () => void;
		const firstPublication = new Promise<void>((resolve) => {
			finishFirstTick = resolve;
		});
		let secondTickStarted!: () => void;
		const secondStarted = new Promise<void>((resolve) => {
			secondTickStarted = resolve;
		});
		const loop = new AgentCoreDispatchPublisherLoop({
			pool: new FakeLockPool(true),
			publisher: {
				publishPending: async () => {
					publishCalls += 1;
					if (publishCalls === 1) {
						firstTickStarted();
						await firstPublication;
					} else {
						secondTickStarted();
					}
					return {
						status: "enabled",
						publishedRunIds: [],
						ambiguousRunIds: [],
					};
				},
			},
			pendingStore: { oldestUnpublishedAdmittedAt: async () => null },
			intervalMs: 100,
			logger: new RecordingLogger(),
		});

		loop.start();
		await firstStarted;
		await new Promise((resolve) => setTimeout(resolve, 110));
		finishFirstTick();
		await Promise.race([
			secondStarted,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("second tick missed the fixed cadence")),
					50,
				),
			),
		]);
		await loop.stop();
	});

	it("ticks within the configured interval and drains its lock on stop", async () => {
		const pool = new TrackingGrantedLockPool();
		let tickStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			tickStarted = resolve;
		});
		let finishTick!: () => void;
		const publication = new Promise<{
			status: "enabled";
			publishedRunIds: string[];
			ambiguousRunIds: string[];
		}>((resolve) => {
			finishTick = () =>
				resolve({
					status: "enabled",
					publishedRunIds: [dispatch.runId],
					ambiguousRunIds: [],
				});
		});
		const loop = new AgentCoreDispatchPublisherLoop({
			pool,
			publisher: {
				publishPending: async () => {
					tickStarted();
					return await publication;
				},
			},
			pendingStore: {
				oldestUnpublishedAdmittedAt: async () => dispatch.admittedAt,
			},
			intervalMs: 1,
			logger: new RecordingLogger(),
		});

		loop.start();
		await started;
		let stopped = false;
		const stop = loop.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);

		finishTick();
		await stop;
		expect(pool.unlocks).toBe(1);
		expect(pool.releases).toBe(1);
	});
});
