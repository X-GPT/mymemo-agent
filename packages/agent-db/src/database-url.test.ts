import { describe, expect, it } from "bun:test";
import { resolveDatabaseUrl } from "./database-url";

describe("resolveDatabaseUrl", () => {
	it("splices an encoded password and enables the shared TLS mode", () => {
		expect(
			resolveDatabaseUrl(
				"postgresql://agent@db.example/mymemo_agent",
				"s/ecret",
				undefined,
			),
		).toBe(
			"postgresql://agent:s%2Fecret@db.example/mymemo_agent?sslmode=no-verify",
		);
	});

	it("preserves an existing password and explicit TLS mode", () => {
		expect(
			resolveDatabaseUrl(
				"postgresql://agent:existing@db.example/mymemo_agent?sslmode=verify-full",
				"replacement",
				undefined,
			),
		).toBe(
			"postgresql://agent:existing@db.example/mymemo_agent?sslmode=verify-full",
		);
	});

	it("allows local callers to disable TLS and preserves a missing URL", () => {
		expect(
			resolveDatabaseUrl(
				"postgresql://agent@localhost/mymemo_agent",
				undefined,
				"disable",
			),
		).toBe("postgresql://agent@localhost/mymemo_agent");
		expect(resolveDatabaseUrl(undefined, "secret", undefined)).toBeUndefined();
	});
});
