import { describe, expect, it } from "bun:test";
import { buildHealthResponse } from "./health";
import type { WorkerLogger } from "./logger";
import { Worker } from "./worker";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

describe("buildHealthResponse", () => {
	it("serves the worker's health snapshot as JSON", async () => {
		const worker = new Worker({
			workerId: "worker-h",
			maxConcurrentRuns: 2,
			shutdownTimeoutMs: 1_000,
			logger: silentLogger,
		});
		const res = buildHealthResponse(worker);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({
			status: "ok",
			workerId: "worker-h",
			activeRuns: 0,
			maxConcurrentRuns: 2,
			draining: false,
		});
	});
});
