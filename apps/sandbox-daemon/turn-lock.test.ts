import { describe, expect, it } from "bun:test";
import { acquireTurn } from "./turn-lock";

describe("turn-lock", () => {
	it("acquires and releases a turn", () => {
		const lock = acquireTurn("turn-1");
		expect(lock).not.toBeNull();

		// While the slot is held, a second acquire is rejected.
		expect(acquireTurn("turn-2")).toBeNull();

		lock?.release();

		// After release, a new turn can be acquired.
		const next = acquireTurn("turn-3");
		expect(next).not.toBeNull();
		next?.release();
	});

	it("rejects concurrent turn", () => {
		const lock1 = acquireTurn("turn-a");
		expect(lock1).not.toBeNull();

		const lock2 = acquireTurn("turn-b");
		expect(lock2).toBeNull();

		lock1?.release();

		// Now a new turn can be acquired
		const lock3 = acquireTurn("turn-c");
		expect(lock3).not.toBeNull();
		lock3?.release();
	});

	it("release is idempotent", () => {
		const lock = acquireTurn("turn-x");
		expect(lock).not.toBeNull();

		lock?.release();
		lock?.release(); // second release should be safe

		// The slot is free again.
		const next = acquireTurn("turn-y");
		expect(next).not.toBeNull();
		next?.release();
	});

	it("release only releases matching turn", () => {
		const lock1 = acquireTurn("turn-1");
		expect(lock1).not.toBeNull();
		lock1?.release();

		const lock2 = acquireTurn("turn-2");
		expect(lock2).not.toBeNull();

		// Releasing lock1 again should NOT release lock2 — the slot stays held.
		lock1?.release();
		expect(acquireTurn("turn-3")).toBeNull();

		lock2?.release();
	});
});
