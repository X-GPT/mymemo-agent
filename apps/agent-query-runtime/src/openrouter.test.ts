import { expect, it } from "bun:test";
import { resolveClaudeEnvironment } from "./openrouter";

it("resolves the deployed OpenRouter credential from Secrets Manager", async () => {
	const env: Record<string, string | undefined> = {
		AWS_REGION: "us-west-2",
		OPENROUTER_API_KEY_SECRET_ARN: "arn:openrouter",
		OPENROUTER_BASE_URL: "https://openrouter.ai/api",
	};
	const reads: string[][] = [];

	const result = await resolveClaudeEnvironment(env, async (arn, region) => {
		reads.push([arn, region]);
		return "secret";
	});

	expect(reads).toEqual([["arn:openrouter", "us-west-2"]]);
	expect(result).toEqual({
		ANTHROPIC_AUTH_TOKEN: "secret",
		ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
		ANTHROPIC_API_KEY: "",
	});
	expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});
