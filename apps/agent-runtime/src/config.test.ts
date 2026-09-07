import { expect, test } from "bun:test";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readOpenRouterKey } from "./config";

test("deployed bootstrap reads AWSCURRENT and never falls back to a local key", async () => {
	const client = new SecretsManagerClient({ region: "us-west-2" });
	const env = {
		OPENROUTER_API_KEY_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:key-abcdef",
		OPENROUTER_API_KEY: "local-key",
	};
	client.send = async (command) => {
		expect(command.input as unknown).toEqual({
			SecretId: env.OPENROUTER_API_KEY_SECRET_ARN,
			VersionStage: "AWSCURRENT",
		});
		return { SecretString: "secret-key" };
	};
	expect(await readOpenRouterKey(env, client)).toBe("secret-key");
	client.send = async () => ({});
	await expect(readOpenRouterKey(env, client)).rejects.toThrow("missing");
	client.send = async () => {
		throw new Error("access denied");
	};
	await expect(readOpenRouterKey(env, client)).rejects.toThrow("access denied");
	expect(
		await readOpenRouterKey({ OPENROUTER_API_KEY: "local-key" }, client),
	).toBe("local-key");
	await expect(readOpenRouterKey({}, client)).rejects.toThrow("missing");
	client.destroy();
});
