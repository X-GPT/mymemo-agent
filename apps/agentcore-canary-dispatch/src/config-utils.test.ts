import { describe, expect, it } from "bun:test";
import { createRetryableAsyncSingleton, requireEnv } from "./config-utils";

describe("AgentCore canary configuration utilities", () => {
	it("requires a non-empty deployment value", () => {
		expect(requireEnv({ VALUE: "configured" }, "VALUE")).toBe("configured");
		expect(() => requireEnv({ VALUE: "  " }, "VALUE")).toThrow(
			"VALUE is required",
		);
	});

	it("shares concurrent initialization and retries after a failure", async () => {
		let attempts = 0;
		const singleton = createRetryableAsyncSingleton(async () => {
			attempts++;
			if (attempts === 1) throw new Error("temporary failure");
			return { ready: true };
		});

		const failures = await Promise.allSettled([singleton(), singleton()]);
		expect(failures).toHaveLength(2);
		for (const failure of failures) {
			expect(failure.status).toBe("rejected");
			if (failure.status === "rejected") {
				expect(failure.reason).toEqual(new Error("temporary failure"));
			}
		}
		expect(attempts).toBe(1);

		const recovered = await singleton();
		expect(recovered).toEqual({ ready: true });
		expect(await singleton()).toBe(recovered);
		expect(attempts).toBe(2);
	});
});
