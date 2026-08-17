import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import { createCanaryDispatchPublisher } from "agentcore-canary-dispatch/publisher";
import type {
	AdvisoryLockClient,
	AdvisoryLockPool,
} from "../cleanup/advisory-lock";
import type { WorkerLogger } from "../logger";
import {
	publishAgentCoreDispatchTick,
	runAgentCoreDispatchPublisher,
} from "./publisher-loop";

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

describe("publishAgentCoreDispatchTick", () => {
	it("makes the old publisher task a no-op during deployment overlap", async () => {
		const logger = new RecordingLogger();
		let publishCalls = 0;

		await expect(
			publishAgentCoreDispatchTick({
				pool: new FakeLockPool(false),
				publisher: {
					async publishPending() {
						publishCalls += 1;
						return {
							status: "enabled",
							publishedRunIds: [],
							ambiguousRunIds: [],
						};
					},
				},
				pendingStore: { oldestUnpublishedAdmittedAt: async () => null },
				logger,
			}),
		).resolves.toEqual({ outcome: "lost_lock" });

		expect(publishCalls).toBe(0);
		expect(logger.infoRecords).toMatchObject([
			{ outcome: "lost_lock", PublisherLostLock: 1 },
		]);
	});

	it("publishes nothing behind the disabled gate and records pending age", async () => {
		const logger = new RecordingLogger();
		const calls: string[] = [];

		await expect(
			publishAgentCoreDispatchTick({
				pool: new FakeLockPool(true),
				publisher: createCanaryDispatchPublisher({
					publisherId: "publisher-1",
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
						confirm: async () => true,
					},
					queue: {
						send: async () => {
							calls.push("send");
						},
					},
				}),
				pendingStore: {
					oldestUnpublishedAdmittedAt: async () => dispatch.admittedAt,
				},
				now: () => new Date("2026-08-17T12:00:05.000Z"),
				logger,
			}),
		).resolves.toEqual({ outcome: "disabled", pendingAgeMs: 5_000 });

		expect(calls).toEqual(["control"]);
		expect(logger.infoRecords).toMatchObject([
			{ outcome: "disabled", PendingAgeMs: 5_000 },
		]);
	});

	it("records an ambiguous send without marking the dispatch published", async () => {
		const logger = new RecordingLogger();
		let confirmed = false;

		await expect(
			publishAgentCoreDispatchTick({
				pool: new FakeLockPool(true),
				publisher: createCanaryDispatchPublisher({
					publisherId: "publisher-1",
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
				now: () => new Date("2026-08-17T12:00:05.000Z"),
				logger,
			}),
		).resolves.toEqual({ outcome: "error", pendingAgeMs: 5_000 });

		expect(confirmed).toBe(false);
		expect(logger.errorRecords).toMatchObject([
			{
				reason: "ambiguous_send",
				ambiguousCount: 1,
				PublisherErrors: 1,
			},
		]);
	});
});

describe("runAgentCoreDispatchPublisher", () => {
	it("continues after a failed tick and stops when its signal aborts", async () => {
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
					return {
						status: "enabled",
						publishedRunIds: [],
						ambiguousRunIds: [],
					};
				},
			},
			pendingStore: { oldestUnpublishedAdmittedAt: async () => null },
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
			{
				reason: "tick_failed",
				error: "SSM unavailable",
				PublisherErrors: 1,
			},
		]);
	});
});
