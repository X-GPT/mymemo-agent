import { describe, expect, it } from "bun:test";
import {
	loadRuntimeBootstrapConfig,
	resolveRuntimeWorkerConfig,
} from "./config";

function bootstrapEnv(): Record<string, string | undefined> {
	return {
		AWS_REGION: "us-west-2",
		CANARY_ENABLED_PARAMETER_NAME: "/mymemo/canary/enabled",
		CANARY_AGENT_DATABASE_URL_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-AbCdEf",
		CANARY_KB_DATABASE_URL_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:kb-db-AbCdEf",
		CANARY_OPENROUTER_API_KEY_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:openrouter-AbCdEf",
		CANARY_E2B_API_KEY_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:e2b-AbCdEf",
		CANARY_REDIS_URL_SECRET_ARN:
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
	it("accepts only exact secret ARNs and non-secret boot values", () => {
		const config = loadRuntimeBootstrapConfig(bootstrapEnv());

		expect(config.port).toBe(8080);
		expect(config.heartbeatIntervalMs).toBe(15_000);
		expect(config.shutdownTimeoutMs).toBe(30_000);
		expect(Object.values(config.secretArns)).toHaveLength(5);
		expect(config.rdsCaBundlePath).toBe("/etc/ssl/certs/rds-global-bundle.pem");
	});

	it("rejects secret values in the Runtime environment", () => {
		for (const secretName of [
			"AGENT_DATABASE_URL",
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

	it("distinguishes a missing secret ARN from a malformed one", () => {
		const env = bootstrapEnv();
		delete env.CANARY_REDIS_URL_SECRET_ARN;
		expect(() => loadRuntimeBootstrapConfig(env)).toThrow(
			"CANARY_REDIS_URL_SECRET_ARN is required",
		);
	});

	it("rejects secret ARNs outside the commercial AWS partition", () => {
		const env = bootstrapEnv();
		env.CANARY_AGENT_DATABASE_URL_SECRET_ARN =
			"arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:agent-db-AbCdEf";
		expect(() => loadRuntimeBootstrapConfig(env)).toThrow(
			"CANARY_AGENT_DATABASE_URL_SECRET_ARN must be an exact Secrets Manager ARN",
		);
	});

	it("reads current secret values into memory and requires verified database TLS", async () => {
		const bootstrap = loadRuntimeBootstrapConfig(bootstrapEnv());
		const values = new Map([
			[
				bootstrap.secretArns.agentDatabaseUrl,
				"postgresql://agent:secret@agent.example:5432/mymemo_agent?sslmode=verify-full",
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

	it("refuses a database secret that weakens certificate verification", async () => {
		const bootstrap = loadRuntimeBootstrapConfig(bootstrapEnv());
		await expect(
			resolveRuntimeWorkerConfig(bootstrap, async (arn) => {
				if (arn === bootstrap.secretArns.agentDatabaseUrl) {
					return "postgresql://agent:secret@agent.example/mymemo_agent?sslmode=no-verify";
				}
				if (arn === bootstrap.secretArns.kbDatabaseUrl) {
					return "postgresql://kb:secret@kb.example/mymemo_kb?sslmode=verify-full";
				}
				if (arn === bootstrap.secretArns.redisUrl) {
					return "rediss://default:secret@redis.example:6379";
				}
				return "secret";
			}),
		).rejects.toThrow(/verify-full/);
	});
});
