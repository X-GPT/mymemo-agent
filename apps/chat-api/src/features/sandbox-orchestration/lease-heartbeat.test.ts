import { describe, expect, it } from "bun:test";
import { LeaseHeartbeat } from "./lease-heartbeat";

/** Wait until `cond()` holds or the budget runs out (keeps timer tests honest). */
async function until(cond: () => boolean, budgetMs = 500) {
	const deadline = Date.now() + budgetMs;
	while (!cond() && Date.now() < deadline) await Bun.sleep(2);
}

describe("LeaseHeartbeat", () => {
	it("renews repeatedly while the hold is kept", async () => {
		let beats = 0;
		const hb = new LeaseHeartbeat(
			async () => {
				beats++;
				return true;
			},
			() => {},
			3,
		);
		hb.start();
		await until(() => beats >= 3);
		hb.stop();
		expect(beats).toBeGreaterThanOrEqual(3);
	});

	it("fires onLost and stops when the hold is lost", async () => {
		let lost = false;
		let beats = 0;
		const hb = new LeaseHeartbeat(
			async () => {
				beats++;
				return false; // lease lost
			},
			() => {
				lost = true;
			},
			3,
		);
		hb.start();
		await until(() => lost);
		expect(lost).toBe(true);

		const after = beats;
		await Bun.sleep(20);
		expect(beats).toBe(after); // stopped — no further beats
	});

	it("tolerates a transient error but gives up after maxErrors", async () => {
		let lost = false;
		const hb = new LeaseHeartbeat(
			async () => {
				throw new Error("db blip");
			},
			() => {
				lost = true;
			},
			3,
			2, // maxErrors
		);
		hb.start();
		await until(() => lost);
		// First throw is tolerated (held), second crosses maxErrors → onLost.
		expect(lost).toBe(true);
		hb.stop();
	});

	it("stop() halts further beats", async () => {
		let beats = 0;
		const hb = new LeaseHeartbeat(
			async () => {
				beats++;
				return true;
			},
			() => {},
			3,
		);
		hb.start();
		await until(() => beats >= 1);
		hb.stop();
		const after = beats;
		await Bun.sleep(20);
		expect(beats).toBe(after);
	});
});
