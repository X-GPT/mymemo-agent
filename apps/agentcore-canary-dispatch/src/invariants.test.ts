import { describe, expect, it } from "bun:test";
import { CANARY_QUEUE_INVARIANTS } from "./invariants";

describe("production Canary queue invariants", () => {
	it("holds a dispatch invisible for longer than its consumer may run", () => {
		// The one relation between these values that a plausible edit can break:
		// a visibility window at or below the consumer timeout lets SQS redeliver
		// a dispatch whose first delivery is still executing.
		expect(CANARY_QUEUE_INVARIANTS.visibilityTimeoutSeconds).toBeGreaterThan(
			CANARY_QUEUE_INVARIANTS.consumerTimeoutSeconds,
		);
	});
});
