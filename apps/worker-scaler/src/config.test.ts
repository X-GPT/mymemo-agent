import { describe, expect, it } from "bun:test";
import { loadWorkerScalerConfigFromEnv } from "./config";

function baseEnv(): Record<string, string | undefined> {
	return {
		AGENT_DATABASE_URL: "postgresql://u@localhost:5432/mymemo_agent",
		AWS_REGION: "us-west-2",
		WORKER_SCALER_ECS_CLUSTER: "cluster-1",
		WORKER_SCALER_ECS_SERVICE: "service-1",
		WORKER_SCALER_MAX_TASKS: "20",
		DB_SSL: "disable",
	};
}

describe("loadWorkerScalerConfigFromEnv", () => {
	it("loads the required scheduled scaler settings", () => {
		const config = loadWorkerScalerConfigFromEnv(baseEnv());

		expect(config).toMatchObject({
			agentDatabaseUrl: "postgresql://u@localhost:5432/mymemo_agent",
			awsRegion: "us-west-2",
			ecsCluster: "cluster-1",
			ecsService: "service-1",
			scaler: {
				minTasks: 1,
				maxTasks: 20,
				targetConcurrentConversationsPerTask: 2,
				scaleInCooldownMs: 600_000,
			},
		});
	});

	for (const key of [
		"AGENT_DATABASE_URL",
		"AWS_REGION",
		"WORKER_SCALER_ECS_CLUSTER",
		"WORKER_SCALER_ECS_SERVICE",
		"WORKER_SCALER_MAX_TASKS",
	]) {
		it(`refuses to boot without ${key}`, () => {
			const env = baseEnv();
			delete env[key];
			expect(() => loadWorkerScalerConfigFromEnv(env)).toThrow(new RegExp(key));
		});
	}

	it("honors scaler sizing overrides", () => {
		const env = baseEnv();
		env.WORKER_SCALER_MIN_TASKS = "2";
		env.WORKER_SCALER_MAX_TASKS = "12";
		env.WORKER_SCALER_TARGET_CONCURRENT_RUNS_PER_TASK = "4";
		env.WORKER_SCALER_SCALE_IN_COOLDOWN_MS = "300000";

		const config = loadWorkerScalerConfigFromEnv(env);

		expect(config.scaler).toEqual({
			minTasks: 2,
			maxTasks: 12,
			targetConcurrentConversationsPerTask: 4,
			scaleInCooldownMs: 300_000,
		});
	});

	it("rejects max lower than min", () => {
		const env = baseEnv();
		env.WORKER_SCALER_MIN_TASKS = "3";
		env.WORKER_SCALER_MAX_TASKS = "2";

		expect(() => loadWorkerScalerConfigFromEnv(env)).toThrow(
			/WORKER_SCALER_MAX_TASKS/,
		);
	});

	it("splices DB_PASSWORD into a passwordless agent DB URL", () => {
		const env = baseEnv();
		env.DB_PASSWORD = "p@ss word";

		const config = loadWorkerScalerConfigFromEnv(env);

		expect(config.agentDatabaseUrl).toBe(
			"postgresql://u:p%40ss%20word@localhost:5432/mymemo_agent",
		);
	});
});
