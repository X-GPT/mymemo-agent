import { describe, expect, it } from "bun:test";
import { startSandboxRenewal } from "./sandbox-renewal";

/** Poll until `predicate` holds, failing the test after `timeoutMs`. */
async function until(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await Bun.sleep(5);
	}
}

describe("startSandboxRenewal", () => {
	it("renews repeatedly on the interval until stopped", async () => {
		let renews = 0;
		const renewal = startSandboxRenewal({
			renew: async () => {
				renews++;
			},
			intervalMs: 10,
			onFailure: () => {
				throw new Error("must not fail");
			},
		});

		await until(() => renews >= 3);
		renewal.stop();
		const atStop = renews;
		await Bun.sleep(50);

		expect(renews).toBe(atStop);
	});

	it("reports a renewal failure once and stops renewing", async () => {
		let renews = 0;
		const failures: unknown[] = [];
		const renewal = startSandboxRenewal({
			renew: async () => {
				renews++;
				throw new Error("sandbox gone");
			},
			intervalMs: 5,
			onFailure: (error) => {
				failures.push(error);
			},
		});

		await until(() => failures.length >= 1);
		await Bun.sleep(30);
		renewal.stop();

		expect(failures).toHaveLength(1);
		expect((failures[0] as Error).message).toBe("sandbox gone");
		// The failed renew was the last one: a dead sandbox is not re-extended.
		expect(renews).toBe(1);
	});

	it("does not renew after stop even if a fire was already due", async () => {
		let renews = 0;
		const renewal = startSandboxRenewal({
			renew: async () => {
				renews++;
			},
			intervalMs: 5,
			onFailure: () => {},
		});
		renewal.stop();

		await Bun.sleep(30);

		expect(renews).toBe(0);
	});
});
