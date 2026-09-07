import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

async function readSecret(
	env: Record<string, string | undefined>,
	name: string,
	client: SecretsManagerClient,
) {
	// Direct env is for the local smoke; a deployed Runtime always uses AWSCURRENT.
	const arn = env[`${name}_SECRET_ARN`];
	const token = arn
		? (
				await client.send(
					new GetSecretValueCommand({
						SecretId: arn,
						VersionStage: "AWSCURRENT",
					}),
				)
			).SecretString
		: env[name];
	if (!token) throw new Error(`${name} is missing`);
	return token;
}

export function readOpenRouterKey(
	env: Record<string, string | undefined>,
	client = new SecretsManagerClient({ region: env.AWS_REGION }),
) {
	return readSecret(env, "OPENROUTER_API_KEY", client);
}

export async function readKbDatabaseUrl(
	env: Record<string, string | undefined>,
	client = new SecretsManagerClient({ region: env.AWS_REGION }),
) {
	const value = await readSecret(env, "KB_DATABASE_URL", client);
	const url = URL.canParse(value) ? new URL(value) : null;
	if (
		!url ||
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!url.hostname ||
		url.searchParams.getAll("sslmode").length !== 1 ||
		url.searchParams.get("sslmode") !== "verify-full"
	) {
		throw new Error(
			"KB_DATABASE_URL must be a PostgreSQL URL using sslmode=verify-full",
		);
	}
	return value;
}
