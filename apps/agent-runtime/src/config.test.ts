import { expect, test } from "bun:test";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readKbDatabaseUrl, readOpenRouterKey } from "./config";

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

test("KB bootstrap requires a verified PostgreSQL URL and never falls back from AWSCURRENT", async () => {
	const client = new SecretsManagerClient({ region: "us-west-2" });
	const url =
		"postgresql://reader:secret@kb.example/mymemo_kb?sslmode=verify-full";
	const env = {
		KB_DATABASE_URL_SECRET_ARN:
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:kb-abcdef",
		KB_DATABASE_URL: url,
	};
	client.send = async (command) => {
		expect(command.input as unknown).toEqual({
			SecretId: env.KB_DATABASE_URL_SECRET_ARN,
			VersionStage: "AWSCURRENT",
		});
		return { SecretString: url };
	};
	expect(await readKbDatabaseUrl(env, client)).toBe(url);
	expect(await readKbDatabaseUrl({ KB_DATABASE_URL: url }, client)).toBe(url);
	client.send = async () => ({});
	await expect(readKbDatabaseUrl(env, client)).rejects.toThrow("missing");
	client.send = async () => {
		throw new Error("access denied");
	};
	await expect(readKbDatabaseUrl(env, client)).rejects.toThrow("access denied");
	await expect(readKbDatabaseUrl({}, client)).rejects.toThrow("missing");
	for (const value of [
		"not a URL",
		"https://kb.example/?sslmode=verify-full",
		"postgresql:///mymemo_kb?sslmode=verify-full",
		url.replace("?sslmode=verify-full", ""),
		url.replace("verify-full", "require"),
		`${url}&sslmode=disable`,
	]) {
		await expect(
			readKbDatabaseUrl({ KB_DATABASE_URL: value }, client),
		).rejects.toThrow("sslmode=verify-full");
	}
	client.destroy();
});
