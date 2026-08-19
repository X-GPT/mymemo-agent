import { describe, expect, it } from "bun:test";
import type { PublisherLogger } from "./logger";
import {
	recordPublisherLockNotAcquired,
	recordPublisherPublication,
	recordPublisherTickFailure,
} from "./publisher-metrics";

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

describe("recordPublisherLockNotAcquired", () => {
	it("records deployment overlap as informational contention", () => {
		const logger = new RecordingLogger();
		recordPublisherLockNotAcquired(logger);

		expect(logger.infoRecords).toMatchObject([
			{
				outcome: "lock_not_acquired",
				PublisherLockNotAcquired: 1,
			},
		]);
		expect(logger.infoRecords[0]?._aws).toMatchObject({
			CloudWatchMetrics: [
				{
					Metrics: [{ Name: "PublisherLockNotAcquired", Unit: "Count" }],
				},
			],
		});
	});
});

describe("recordPublisherPublication", () => {
	it("records disabled ticks and pending age", () => {
		const logger = new RecordingLogger();
		recordPublisherPublication(
			logger,
			{ status: "disabled", ambiguousRunIds: [] },
			5_000,
		);

		expect(logger.infoRecords).toMatchObject([
			{ outcome: "disabled", PendingAgeMs: 5_000 },
		]);
	});

	it("records ambiguous sends as publisher errors", () => {
		const logger = new RecordingLogger();
		recordPublisherPublication(
			logger,
			{ status: "enabled", ambiguousRunIds: ["run-481"] },
			5_000,
		);

		expect(logger.errorRecords).toMatchObject([
			{
				reason: "ambiguous_send",
				ambiguousCount: 1,
				PendingAgeMs: 5_000,
				PublisherErrors: 1,
			},
		]);
	});
});

describe("recordPublisherTickFailure", () => {
	it("retains a pending age sampled before the failure", () => {
		const logger = new RecordingLogger();
		recordPublisherTickFailure(logger, new Error("SSM unavailable"), 5_000);

		expect(logger.errorRecords).toMatchObject([
			{
				reason: "tick_failed",
				error: "SSM unavailable",
				PendingAgeMs: 5_000,
				PublisherErrors: 1,
			},
		]);
	});

	it("omits pending age when sampling itself failed", () => {
		const logger = new RecordingLogger();
		recordPublisherTickFailure(logger, new Error("database unavailable"));

		expect(logger.errorRecords[0]).not.toHaveProperty("PendingAgeMs");
		expect(logger.errorRecords[0]?._aws).toMatchObject({
			CloudWatchMetrics: [
				{ Metrics: [{ Name: "PublisherErrors", Unit: "Count" }] },
			],
		});
	});
});
