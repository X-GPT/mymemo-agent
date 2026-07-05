import { describe, expect, it } from "bun:test";
import { parseRunNotification, RunWakeupRegistry } from "./run-notifier";

describe("parseRunNotification", () => {
	it("extracts a string runId", () => {
		expect(parseRunNotification('{"runId":"run-1"}')).toBe("run-1");
	});

	it("returns null for missing, malformed, or wrong-typed payloads", () => {
		expect(parseRunNotification(undefined)).toBeNull();
		expect(parseRunNotification("")).toBeNull();
		expect(parseRunNotification("not json")).toBeNull();
		expect(parseRunNotification('{"runId":42}')).toBeNull();
		expect(parseRunNotification('{"other":"x"}')).toBeNull();
	});
});

describe("RunWakeupRegistry", () => {
	it("wakes a waiting subscription immediately on signal", async () => {
		const registry = new RunWakeupRegistry();
		const sub = registry.subscribe("run-1");

		let woke = false;
		const wait = sub.waitForWakeup(10_000).then(() => {
			woke = true;
		});
		// Let the wait register its resolver before signaling.
		await Promise.resolve();
		registry.signal("run-1");
		await wait;

		expect(woke).toBe(true);
	});

	it("coalesces a signal that arrives before the next wait (no lost wake-up)", async () => {
		const registry = new RunWakeupRegistry();
		const sub = registry.subscribe("run-1");

		// Signal fires while nobody is waiting.
		registry.signal("run-1");
		// The next wait resolves immediately from the pending latch, not the timeout.
		await sub.waitForWakeup(10_000);

		// The latch is one-shot: a second wait now blocks until the timeout.
		const start = performance.now();
		await sub.waitForWakeup(20);
		expect(performance.now() - start).toBeGreaterThanOrEqual(15);
	});

	it("falls back to the timeout when no signal arrives", async () => {
		const registry = new RunWakeupRegistry();
		const sub = registry.subscribe("run-1");
		const start = performance.now();
		await sub.waitForWakeup(20);
		expect(performance.now() - start).toBeGreaterThanOrEqual(15);
	});

	it("only wakes subscriptions for the signaled run", async () => {
		const registry = new RunWakeupRegistry();
		const other = registry.subscribe("run-2");
		let otherWoke = false;
		other.waitForWakeup(30).then(() => {
			otherWoke = true;
		});
		await Promise.resolve();

		registry.signal("run-1"); // different run
		await Promise.resolve();
		expect(otherWoke).toBe(false);
	});

	it("does not wake a closed subscription", async () => {
		const registry = new RunWakeupRegistry();
		const sub = registry.subscribe("run-1");
		await sub.close();
		// Signaling a run with no live waiters is a no-op and must not throw.
		expect(() => registry.signal("run-1")).not.toThrow();
	});
});
