import { describe, expect, it } from "bun:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { createCurrentSecretReader } from "agentcore-canary-dispatch/secret-config";
import { loadRuntimeBootstrapConfig } from "./config";
import { createProductionCanaryRuntime } from "./production";

function bootstrapConfig() {
	return loadRuntimeBootstrapConfig({
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
	});
}

describe("production AgentCore Runtime boot", () => {
	it("requests only the AWSCURRENT version of an exact secret", async () => {
		let input: unknown;
		const read = createCurrentSecretReader({
			send: async (command) => {
				input = command.input;
				return { SecretString: "current-value" };
			},
		});

		expect(await read(bootstrapConfig().secretArns.agentDatabaseUrl)).toBe(
			"current-value",
		);
		expect(input).toEqual({
			SecretId: bootstrapConfig().secretArns.agentDatabaseUrl,
			VersionStage: "AWSCURRENT",
		});
	});

	it("fails before becoming healthy when fresh-session secret resolution fails", async () => {
		let reads = 0;
		await expect(
			createProductionCanaryRuntime({
				bootstrap: bootstrapConfig(),
				bootId: "boot-451",
				processEnv: {},
				readCurrentSecret: async () => {
					reads++;
					throw new Error("Secrets Manager unavailable");
				},
				ssmClient: new SSMClient({ region: "us-west-2" }),
			}),
		).rejects.toThrow("Secrets Manager unavailable");
		expect(reads).toBeGreaterThan(0);
	});
});
