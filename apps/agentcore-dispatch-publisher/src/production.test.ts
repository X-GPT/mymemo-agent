import { describe, expect, it } from "bun:test";
import { drainPendingAgentCoreDispatches } from "./production";
import { PublisherTickFailure } from "./publisher-tick-failure";

function published(count: number) {
	return {
		status: "enabled" as const,
		publishedRunIds: Array.from(
			{ length: count },
			(_, index) => `run-${index}`,
		),
		ambiguousRunIds: [],
	};
}

describe("drainPendingAgentCoreDispatches", () => {
	it("drains every bounded batch in one tick", async () => {
		const batches = [published(10), published(10), published(3)];
		let publishCalls = 0;

		await drainPendingAgentCoreDispatches({
			signal: new AbortController().signal,
			loadPendingAgeMs: async () => 0,
			publishBatch: async () => batches[publishCalls++] ?? published(0),
			recordPublication() {},
		});

		expect(publishCalls).toBe(3);
	});

	it("stops draining after an ambiguous send", async () => {
		let publishCalls = 0;

		await drainPendingAgentCoreDispatches({
			signal: new AbortController().signal,
			loadPendingAgeMs: async () => 0,
			publishBatch: async () => {
				publishCalls += 1;
				return {
					...published(9),
					ambiguousRunIds: ["run-ambiguous"],
				};
			},
			recordPublication() {},
		});

		expect(publishCalls).toBe(1);
	});

	it("honors shutdown between batches", async () => {
		const shutdown = new AbortController();
		let publishCalls = 0;

		await drainPendingAgentCoreDispatches({
			signal: shutdown.signal,
			loadPendingAgeMs: async () => 0,
			publishBatch: async () => {
				publishCalls += 1;
				shutdown.abort();
				return published(10);
			},
			recordPublication() {},
		});

		expect(publishCalls).toBe(1);
	});

	it("does not begin a batch when shutdown arrives during age sampling", async () => {
		const shutdown = new AbortController();
		let publishCalls = 0;

		await drainPendingAgentCoreDispatches({
			signal: shutdown.signal,
			loadPendingAgeMs: async () => {
				shutdown.abort();
				return 0;
			},
			publishBatch: async () => {
				publishCalls += 1;
				return published(10);
			},
			recordPublication() {},
		});

		expect(publishCalls).toBe(0);
	});

	it("preserves the sampled pending age when publication fails", async () => {
		const failure = new Error("SSM unavailable");
		let caught: unknown;
		try {
			await drainPendingAgentCoreDispatches({
				signal: new AbortController().signal,
				loadPendingAgeMs: async () => 5_000,
				publishBatch: async () => {
					throw failure;
				},
				recordPublication() {},
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PublisherTickFailure);
		expect(caught).toMatchObject({ failure, pendingAgeMs: 5_000 });
	});
});
