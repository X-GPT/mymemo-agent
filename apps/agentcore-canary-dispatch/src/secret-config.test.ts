import { describe, expect, it } from "bun:test";
import {
	createCurrentSecretReader,
	resolveCanaryDatabaseUrlsFromSecretArns,
	verifiedDatabaseUrl,
} from "./secret-config";

describe("AgentCore canary secret configuration", () => {
	it("requests only the AWSCURRENT version of an exact secret", async () => {
		let input: unknown;
		const read = createCurrentSecretReader({
			send: async (command) => {
				input = command.input;
				return { SecretString: "current-value" };
			},
		});

		const arn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-AbCdEf";
		expect(await read(arn)).toBe("current-value");
		expect(input).toEqual({
			SecretId: arn,
			VersionStage: "AWSCURRENT",
		});
	});

	it("reports malformed database URLs distinctly from a missing TLS mode", () => {
		expect(() =>
			verifiedDatabaseUrl("not a url", "AGENT_DATABASE_URL"),
		).toThrow(
			"AGENT_DATABASE_URL must be a PostgreSQL URL using sslmode=verify-full",
		);
		expect(() =>
			verifiedDatabaseUrl(
				"postgresql://db.example.test/agent",
				"AGENT_DATABASE_URL",
			),
		).toThrow("AGENT_DATABASE_URL must use sslmode=verify-full");
	});

	it("resolves database URLs from production-named secret ARN variables", async () => {
		const agentArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-AbCdEf";
		const kbArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:kb-db-AbCdEf";

		await expect(
			resolveCanaryDatabaseUrlsFromSecretArns(
				{
					AGENT_DATABASE_URL_SECRET_ARN: agentArn,
					KB_DATABASE_URL_SECRET_ARN: kbArn,
				},
				async (arn) =>
					arn === agentArn
						? "postgresql://agent.example/mymemo_agent?sslmode=verify-full"
						: "postgresql://kb.example/mymemo_kb?sslmode=verify-full",
			),
		).resolves.toEqual({
			agentDatabaseUrl:
				"postgresql://agent.example/mymemo_agent?sslmode=verify-full",
			kbDatabaseUrl: "postgresql://kb.example/mymemo_kb?sslmode=verify-full",
		});
	});
});
