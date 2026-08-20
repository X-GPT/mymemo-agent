import { describe, expect, it } from "bun:test";
import { AGENTCORE_DISPATCH_QUEUE_INVARIANTS } from "./invariants";

describe("production AgentCore dispatch queue invariants", () => {
	it("holds a dispatch invisible for longer than its consumer may run", () => {
		expect(
			AGENTCORE_DISPATCH_QUEUE_INVARIANTS.visibilityTimeoutSeconds,
		).toBeGreaterThan(
			AGENTCORE_DISPATCH_QUEUE_INVARIANTS.consumerTimeoutSeconds,
		);
	});

	it("leaves the Postgres queued timeout as the effective retry backstop", () => {
		const invariants = AGENTCORE_DISPATCH_QUEUE_INVARIANTS;
		const minimumSecondsBeforeDlq =
			(invariants.maxReceiveCount - 1) * invariants.visibilityTimeoutSeconds;

		expect(minimumSecondsBeforeDlq).toBeGreaterThan(
			invariants.queuedRunTimeoutSeconds,
		);
	});

	it("consumes one dispatch at a time without reserved concurrency", () => {
		expect(AGENTCORE_DISPATCH_QUEUE_INVARIANTS.consumerBatchSize).toBe(1);
		expect(
			AGENTCORE_DISPATCH_QUEUE_INVARIANTS.reservedConsumerConcurrency,
		).toBeNull();
	});
});
