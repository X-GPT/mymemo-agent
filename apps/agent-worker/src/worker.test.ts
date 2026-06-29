import { describe, expect, it } from "bun:test";
import type { WorkerLogger } from "./logger";
import { Worker } from "./worker";

const silentLogger: WorkerLogger = {
	info() {},
	warn() {},
	error() {},
};

/** A task whose completion the test controls. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function buildWorker(overrides: { maxConcurrentRuns?: number } = {}) {
	return new Worker({
		workerId: "worker-test",
		maxConcurrentRuns: overrides.maxConcurrentRuns ?? 2,
		shutdownTimeoutMs: 1_000,
		logger: silentLogger,
	});
}

describe("Worker — concurrency", () => {
	it("starts tasks up to the configured concurrency, then refuses", () => {
		const worker = buildWorker({ maxConcurrentRuns: 2 });
		const a = deferred();
		const b = deferred();

		expect(worker.tryStart(() => a.promise)).toBe(true);
		expect(worker.tryStart(() => b.promise)).toBe(true);
		// At capacity now.
		expect(worker.tryStart(() => Promise.resolve())).toBe(false);
		expect(worker.activeCount).toBe(2);

		a.resolve();
		b.resolve();
	});

	it("frees a slot when a task completes", async () => {
		const worker = buildWorker({ maxConcurrentRuns: 1 });
		const a = deferred();
		expect(worker.tryStart(() => a.promise)).toBe(true);
		expect(worker.tryStart(() => Promise.resolve())).toBe(false);

		a.resolve();
		await worker.drain();
		expect(worker.activeCount).toBe(0);
		expect(worker.tryStart(() => Promise.resolve())).toBe(true);
	});
});

describe("Worker — graceful shutdown", () => {
	it("stops accepting new tasks once shutdown begins", async () => {
		const worker = buildWorker();
		await worker.shutdown();
		expect(worker.isDraining).toBe(true);
		expect(worker.tryStart(() => Promise.resolve())).toBe(false);
	});

	it("waits for an in-flight task to finish within the timeout", async () => {
		const worker = buildWorker();
		const a = deferred();
		worker.tryStart(() => a.promise);

		// Resolve shortly; shutdown should await it and end with no active tasks.
		setTimeout(() => a.resolve(), 10);
		await worker.shutdown();
		expect(worker.activeCount).toBe(0);
	});

	it("returns within the grace period even if a task hangs", async () => {
		const worker = new Worker({
			workerId: "worker-test",
			maxConcurrentRuns: 1,
			shutdownTimeoutMs: 30,
			logger: silentLogger,
		});
		const hang = deferred(); // never resolved
		worker.tryStart(() => hang.promise);

		const start = Bun.nanoseconds();
		await worker.shutdown();
		const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
		// Bounded by the grace period (with generous slack), not the hung task.
		expect(elapsedMs).toBeLessThan(500);

		hang.resolve();
	});
});

describe("Worker — health snapshot", () => {
	it("is deterministic for a freshly configured worker", () => {
		const worker = buildWorker({ maxConcurrentRuns: 3 });
		expect(worker.healthSnapshot()).toEqual({
			status: "ok",
			workerId: "worker-test",
			activeRuns: 0,
			maxConcurrentRuns: 3,
			draining: false,
		});
	});

	it("reflects active runs and draining state", async () => {
		const worker = buildWorker({ maxConcurrentRuns: 3 });
		const a = deferred();
		worker.tryStart(() => a.promise);
		expect(worker.healthSnapshot().activeRuns).toBe(1);

		a.resolve();
		await worker.shutdown();
		expect(worker.healthSnapshot().draining).toBe(true);
	});
});
