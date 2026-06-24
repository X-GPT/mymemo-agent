import { describe, expect, it, mock } from "bun:test";
import { IdleSandboxReaper } from "./idle-sandbox-reaper";
import type { SandboxLeaseManager } from "./sandbox-lease-manager";

const silentLogger = { info: () => {}, error: () => {} };

/** A manager stub exposing only the sweep the reaper drives. */
function fakeManager(reapIdle: () => Promise<void>) {
	return { reapIdle: mock(reapIdle) } as unknown as Pick<
		SandboxLeaseManager,
		"reapIdle"
	> & { reapIdle: ReturnType<typeof mock> };
}

describe("IdleSandboxReaper", () => {
	it("runs a sweep on tick", async () => {
		const manager = fakeManager(async () => {});
		const reaper = new IdleSandboxReaper(manager, silentLogger);

		await reaper.tick();

		expect(manager.reapIdle).toHaveBeenCalledTimes(1);
		expect(manager.reapIdle).toHaveBeenCalledWith(silentLogger);
	});

	it("contains a sweep failure instead of throwing", async () => {
		const errors: Record<string, unknown>[] = [];
		const manager = fakeManager(async () => {
			throw new Error("store down");
		});
		const reaper = new IdleSandboxReaper(manager, {
			info: () => {},
			error: (obj: Record<string, unknown>) => errors.push(obj),
		});

		await expect(reaper.tick()).resolves.toBeUndefined();
		expect(errors.some((e) => e.msg === "Idle reaper sweep failed")).toBe(true);
	});

	it("does not overlap sweeps", async () => {
		let release: () => void = () => {};
		let holdOpen = true;
		const manager = fakeManager(() => {
			if (!holdOpen) return Promise.resolve();
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const reaper = new IdleSandboxReaper(manager, silentLogger);

		const first = reaper.tick(); // starts the sweep, holds it open
		await reaper.tick(); // in-flight → no-op, must not start a second sweep
		expect(manager.reapIdle).toHaveBeenCalledTimes(1);

		holdOpen = false;
		release();
		await first;
		// Once the first settles, the next tick sweeps again.
		await reaper.tick();
		expect(manager.reapIdle).toHaveBeenCalledTimes(2);
	});

	it("sweeps repeatedly on start and stops cleanly", async () => {
		const manager = fakeManager(async () => {});
		const reaper = new IdleSandboxReaper(manager, silentLogger, 5);

		reaper.start();
		// Let a few intervals fire.
		while (manager.reapIdle.mock.calls.length < 2) await Bun.sleep(2);
		reaper.stop();

		const afterStop = manager.reapIdle.mock.calls.length;
		await Bun.sleep(20);
		// No further sweeps once stopped.
		expect(manager.reapIdle.mock.calls.length).toBe(afterStop);
	});

	it("start is idempotent and stop is safe before start", () => {
		const manager = fakeManager(async () => {});
		const reaper = new IdleSandboxReaper(manager, silentLogger, 1_000);

		expect(() => reaper.stop()).not.toThrow();
		reaper.start();
		reaper.start(); // second start must not schedule a second interval
		reaper.stop();
	});
});
