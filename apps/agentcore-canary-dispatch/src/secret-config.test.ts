import { describe, expect, it } from "bun:test";
import {
	createCurrentSecretReader,
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
});
