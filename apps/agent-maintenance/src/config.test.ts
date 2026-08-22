import { describe, expect, it } from "bun:test";
import { loadMaintenanceConfigFromEnv } from "./config";

const maintenanceEnv = {
	AGENT_DATABASE_URL: "postgresql://agent@db.example.com:5432/mymemo_agent",
	DB_PASSWORD: "secret",
	DB_SSL: "require",
	E2B_API_KEY: "e2b-secret",
	ARTIFACT_BUCKET: "mymemo-artifacts",
	AWS_REGION: "us-west-2",
};

describe("agent-maintenance config", () => {
	it("starts with only maintenance configuration", () => {
		expect(loadMaintenanceConfigFromEnv(maintenanceEnv)).toEqual({
			agentDatabaseUrl:
				"postgresql://agent:secret@db.example.com:5432/mymemo_agent?sslmode=no-verify",
			e2bApiKey: "e2b-secret",
			artifact: { bucket: "mymemo-artifacts", region: "us-west-2" },
			logLevel: "info",
			port: 8080,
		});
	});

	it("does not load Run-serving or Dispatch configuration", () => {
		const config = loadMaintenanceConfigFromEnv({
			...maintenanceEnv,
			KB_DATABASE_URL: "postgresql://kb.example.com/kb",
			OPENROUTER_API_KEY: "model-secret",
			REDIS_URL: "rediss://redis.example.com",
			AGENTCORE_DISPATCH_QUEUE_URL: "https://sqs.example.com/queue",
			WORKER_E2B_TEMPLATE: "run-serving-template",
		});

		expect(Object.keys(config).sort()).toEqual([
			"agentDatabaseUrl",
			"artifact",
			"e2bApiKey",
			"logLevel",
			"port",
		]);
	});

	it("validates port overrides", () => {
		expect(() =>
			loadMaintenanceConfigFromEnv({
				...maintenanceEnv,
				PORT: "0",
			}),
		).toThrow("PORT must be a positive integer");
		expect(() =>
			loadMaintenanceConfigFromEnv({
				...maintenanceEnv,
				PORT: "2147483648",
			}),
		).toThrow("PORT must be a positive integer");
	});
});
