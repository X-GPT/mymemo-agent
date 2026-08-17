import { describe, expect, it } from "bun:test";
import type { PublisherLogger } from "./logger";
import { recordPublisherPublication } from "./publisher-metrics";

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
