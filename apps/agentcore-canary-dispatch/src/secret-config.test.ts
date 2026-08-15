import { describe, expect, it } from "bun:test";
import {
	createCurrentSecretReader,
	createRetryableAsyncSingleton,
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

	it("shares concurrent initialization and retries after a failure", async () => {
		let attempts = 0;
		const singleton = createRetryableAsyncSingleton(async () => {
			attempts++;
			if (attempts === 1) throw new Error("temporary failure");
			return { ready: true };
		});

		const first = singleton();
		const concurrent = singleton();
		const failures = await Promise.allSettled([first, concurrent]);
		expect(failures).toHaveLength(2);
		for (const failure of failures) {
			expect(failure.status).toBe("rejected");
			if (failure.status === "rejected") {
				expect(failure.reason).toEqual(new Error("temporary failure"));
			}
		}
		expect(attempts).toBe(1);

		const recovered = await singleton();
		expect(recovered).toEqual({ ready: true });
		expect(await singleton()).toBe(recovered);
		expect(attempts).toBe(2);
	});
});
