import { describe, expect, it } from "bun:test";
import {
	loadRuntimeBootstrapConfig,
	resolveRuntimeWorkerConfig,
} from "./config";

function bootstrapEnv(): Record<string, string | undefined> {
	return {
		AWS_REGION: "us-west-2",
		AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME:
			"/mymemo/agentcore-dispatch/prod/enabled",
		AGENT_DATABASE_URL:
			"postgresql://mymemo_agent@agent.example:5432/mymemo_agent",
		DB_PASSWORD_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:rds!db-example-AbCdEf",
		KB_DATABASE_URL_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:kb-db-AbCdEf",
		OPENROUTER_API_KEY_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:openrouter-AbCdEf",
		E2B_API_KEY_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:e2b-AbCdEf",
		REDIS_URL_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:redis-AbCdEf",
		OPENROUTER_BASE_URL: "https://openrouter.ai/api",
		OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4",
		WORKER_E2B_TEMPLATE: "mymemo-agent-sandbox",
		ARTIFACT_BUCKET: "private-artifacts",
		RDS_CA_BUNDLE_PATH: "/etc/ssl/certs/rds-global-bundle.pem",
		NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/rds-global-bundle.pem",
	};
}

describe("AgentCore Runtime configuration", () => {
	it("requires secret references and non-secret boot values", () => {
		const config = loadRuntimeBootstrapConfig(bootstrapEnv());

		expect(config.port).toBe(8080);
		expect(config.heartbeatIntervalMs).toBe(15_000);
		expect(config.shutdownTimeoutMs).toBe(30_000);
		expect(config).not.toHaveProperty("artifactObjectKeyPrefix");
		expect(Object.values(config.secretArns)).toHaveLength(5);
		expect(config.rdsCaBundlePath).toBe("/etc/ssl/certs/rds-global-bundle.pem");
	});

	it("rejects secret values in the Runtime environment", () => {
		for (const secretName of [
			"DB_PASSWORD",
			"KB_DATABASE_URL",
			"OPENROUTER_API_KEY",
			"E2B_API_KEY",
			"REDIS_URL",
		]) {
			const env = bootstrapEnv();
			env[secretName] = "must-not-be-ambient";
			expect(() => loadRuntimeBootstrapConfig(env)).toThrow(secretName);
		}
	});

	it("rejects a missing secret reference", () => {
		const env = bootstrapEnv();
		delete env.REDIS_URL_SECRET_ARN;
		expect(() => loadRuntimeBootstrapConfig(env)).toThrow(
			"REDIS_URL_SECRET_ARN is required",
		);
	});

	it("reads current secret values into memory and requires verified database TLS", async () => {
		const bootstrap = loadRuntimeBootstrapConfig(bootstrapEnv());
		const values = new Map([
			[
				bootstrap.secretArns.agentDatabasePassword,
				JSON.stringify({ password: "agent-secret" }),
			],
			[
				bootstrap.secretArns.kbDatabaseUrl,
				"postgresql://kb:secret@kb.example:5432/mymemo_kb?sslmode=verify-full",
			],
			[bootstrap.secretArns.openrouterApiKey, "sk-or-secret"],
			[bootstrap.secretArns.e2bApiKey, "e2b-secret"],
			[
				bootstrap.secretArns.redisUrl,
				"rediss://default:secret@redis.example:6379",
			],
		]);

		const config = await resolveRuntimeWorkerConfig(bootstrap, async (arn) => {
			const value = values.get(arn);
			if (!value) throw new Error("secret missing");
			return value;
		});

		expect(config.agentDatabaseUrl).toContain("sslmode=verify-full");
		expect(config.kbDatabaseUrl).toContain("sslmode=verify-full");
		expect(config.openrouter.apiKey).toBe("sk-or-secret");
		expect(config.maxConcurrentConversations).toBe(1);
		expect(config.shutdownTimeoutMs).toBe(30_000);
	});

	it("refuses a KB database secret that weakens certificate verification", async () => {
		const bootstrap = loadRuntimeBootstrapConfig(bootstrapEnv());
		await expect(
			resolveRuntimeWorkerConfig(bootstrap, async (arn) => {
				if (arn === bootstrap.secretArns.agentDatabasePassword) {
					return JSON.stringify({ password: "agent-secret" });
				}
				if (arn === bootstrap.secretArns.kbDatabaseUrl) {
					return "postgresql://kb:secret@kb.example/mymemo_kb?sslmode=no-verify";
				}
				if (arn === bootstrap.secretArns.redisUrl) {
					return "rediss://default:secret@redis.example:6379";
				}
				return "secret";
			}),
		).rejects.toThrow(/verify-full/);
	});
});
