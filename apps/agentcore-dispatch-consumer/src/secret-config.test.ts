import { describe, expect, it } from "bun:test";
import {
	createCurrentSecretReader,
	resolveVerifiedAgentDatabaseUrl,
	verifiedDatabaseUrl,
} from "./secret-config";

describe("AgentCore secret configuration", () => {
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

	it("materializes the agent-worker passwordless URL with the RDS password secret", () => {
		const resolved = resolveVerifiedAgentDatabaseUrl(
			"postgresql://mymemo_agent@agent.example:5432/mymemo_agent",
			JSON.stringify({ password: "agent password" }),
		);
		const url = new URL(resolved);

		expect(decodeURIComponent(url.password)).toBe("agent password");
		expect(url.searchParams.get("sslmode")).toBe("verify-full");
	});

	it("rejects an ambient password or malformed RDS password secret", () => {
			expect(() =>
			resolveVerifiedAgentDatabaseUrl(
				"postgresql://mymemo_agent:secret@agent.example/mymemo_agent",
				JSON.stringify({ password: "agent password" }),
			),
		).toThrow("without a password");
		expect(() =>
			resolveVerifiedAgentDatabaseUrl(
				"postgresql://mymemo_agent@agent.example/mymemo_agent",
				"not-json",
			),
		).toThrow("DB_PASSWORD secret");
	});
});
