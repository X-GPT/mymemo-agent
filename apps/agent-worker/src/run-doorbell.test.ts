import { describe, expect, it } from "bun:test";
import { DoorbellTicker } from "./run-doorbell";

/** A promise whose resolution the test controls, to hold a tick open. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("DoorbellTicker", () => {
	it("runs one tick when rung while idle", async () => {
		let ticks = 0;
		const ticker = new DoorbellTicker(
			async () => {
				ticks++;
			},
			() => {},
		);

		ticker.ring();
		await Bun.sleep(0);

		expect(ticks).toBe(1);
	});

	it("coalesces rings during an in-flight tick into one trailing tick", async () => {
		const gate = deferred();
		let ticks = 0;
		const ticker = new DoorbellTicker(
			async () => {
				ticks++;
				if (ticks === 1) await gate.promise;
			},
			() => {},
		);

		ticker.ring(); // starts the first tick, held open by the gate
		ticker.ring();
		ticker.ring(); // both rings fold into a single pending trailing tick
		expect(ticks).toBe(1);

		gate.resolve();
		await Bun.sleep(0);
		expect(ticks).toBe(2);

		// The ticker is idle again: a later ring still works.
		ticker.ring();
		await Bun.sleep(0);
		expect(ticks).toBe(3);
	});

	it("ignores rings after stop", async () => {
		let ticks = 0;
		const ticker = new DoorbellTicker(
			async () => {
				ticks++;
			},
			() => {},
		);

		ticker.stop();
		ticker.ring();
		await Bun.sleep(0);

		expect(ticks).toBe(0);
	});

	it("reports a tick error and keeps ticking on later rings", async () => {
		const errors: unknown[] = [];
		let calls = 0;
		const ticker = new DoorbellTicker(
			async () => {
				calls++;
				if (calls === 1) throw new Error("boom");
			},
			(error) => {
				errors.push(error);
			},
		);

		ticker.ring();
		await Bun.sleep(0);
		expect(errors).toHaveLength(1);

		ticker.ring();
		await Bun.sleep(0);
		expect(calls).toBe(2);
	});
});
