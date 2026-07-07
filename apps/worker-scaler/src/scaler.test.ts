import { describe, expect, it } from "bun:test";
import {
	computeDesiredWorkerTasks,
	type DesiredCountAdapter,
	decideWorkerScale,
	runWorkerScaler,
	type ScalerStateStore,
} from "./scaler";

const config = {
	minTasks: 1,
	maxTasks: 20,
	targetConcurrentRunsPerTask: 2,
	scaleInCooldownMs: 10 * 60 * 1000,
};

describe("computeDesiredWorkerTasks", () => {
	it("uses ceil((queuedRuns + runningRuns) / targetConcurrentRunsPerTask)", () => {
		expect(
			computeDesiredWorkerTasks({ queuedRuns: 12, runningRuns: 20 }, config),
		).toBe(16);
	});

	it("clamps the desired task count to min and max", () => {
		expect(
			computeDesiredWorkerTasks({ queuedRuns: 0, runningRuns: 0 }, config),
		).toBe(1);
		expect(
			computeDesiredWorkerTasks(
				{ queuedRuns: 100, runningRuns: 100 },
				{ ...config, maxTasks: 12 },
			),
		).toBe(12);
	});
});

describe("decideWorkerScale", () => {
	it("holds the current desired count during scale-in cooldown", () => {
		const now = new Date("2026-01-01T00:05:00Z");

		const decision = decideWorkerScale({
			metrics: { queuedRuns: 0, runningRuns: 0 },
			config,
			state: {
				currentDesiredTasks: 8,
				lastScaleInAt: new Date("2026-01-01T00:00:00Z"),
			},
			now,
		});

		expect(decision).toEqual({
			desiredTasks: 8,
			shouldUpdateService: false,
			scaleDirection: "none",
			reason: "scale_in_cooldown",
		});
	});

	it("allows scale-in after cooldown expires", () => {
		const decision = decideWorkerScale({
			metrics: { queuedRuns: 0, runningRuns: 0 },
			config,
			state: {
				currentDesiredTasks: 8,
				lastScaleInAt: new Date("2026-01-01T00:00:00Z"),
			},
			now: new Date("2026-01-01T00:11:00Z"),
		});

		expect(decision).toEqual({
			desiredTasks: 1,
			shouldUpdateService: true,
			scaleDirection: "in",
			reason: "queue_depth",
		});
	});
});

describe("runWorkerScaler", () => {
	it("updates ECS through an adapter and records scale-in state", async () => {
		const adapter = new FakeDesiredCountAdapter();
		const state = new FakeScalerStateStore({
			currentDesiredTasks: 8,
			lastScaleInAt: new Date("2026-01-01T00:00:00Z"),
		});
		const now = new Date("2026-01-01T00:11:00Z");

		const result = await runWorkerScaler({
			readMetrics: async () => ({ queuedRuns: 0, runningRuns: 0 }),
			desiredCountAdapter: adapter,
			stateStore: state,
			config,
			now,
		});

		expect(result.decision.desiredTasks).toBe(1);
		expect(adapter.updates).toEqual([1]);
		expect(state.writes).toEqual([
			{
				currentDesiredTasks: 1,
				lastScaleInAt: now,
			},
		]);
	});
});

class FakeDesiredCountAdapter implements DesiredCountAdapter {
	readonly updates: number[] = [];

	async updateDesiredCount(desiredTasks: number): Promise<void> {
		this.updates.push(desiredTasks);
	}
}

class FakeScalerStateStore implements ScalerStateStore {
	readonly writes: Array<{
		currentDesiredTasks: number;
		lastScaleInAt: Date | null;
	}> = [];

	constructor(
		private state: {
			currentDesiredTasks: number;
			lastScaleInAt: Date | null;
		},
	) {}

	async readState() {
		return this.state;
	}

	async writeState(next: {
		currentDesiredTasks: number;
		lastScaleInAt: Date | null;
	}): Promise<void> {
		this.state = next;
		this.writes.push(next);
	}
}
