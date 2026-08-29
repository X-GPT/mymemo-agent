import { expect, it } from "bun:test";
import { loadHarnessConfigFromEnv } from "./harness-env";

const env = {
	VERCEL_TOKEN: "t",
	VERCEL_TEAM_ID: "team",
	VERCEL_PROJECT_ID: "prj",
	OPENROUTER_API_KEY: "key",
	KB_DATABASE_URL: "postgresql://kb:kb@localhost:5432/mymemo_kb",
};

it("requires the read-only KB URL for the document tools", () => {
	expect(loadHarnessConfigFromEnv(env).KB_DATABASE_URL).toBe(
		env.KB_DATABASE_URL,
	);
	expect(() =>
		loadHarnessConfigFromEnv({ ...env, KB_DATABASE_URL: undefined }),
	).toThrow(/KB_DATABASE_URL/);
});
