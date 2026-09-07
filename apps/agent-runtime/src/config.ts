import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export async function readOpenRouterKey(
	env: Record<string, string | undefined>,
	client = new SecretsManagerClient({ region: env.AWS_REGION }),
) {
	// Direct env is for the local smoke; a deployed Runtime always uses AWSCURRENT.
	const arn = env.OPENROUTER_API_KEY_SECRET_ARN;
	const token = arn
		? (
				await client.send(
					new GetSecretValueCommand({
						SecretId: arn,
						VersionStage: "AWSCURRENT",
					}),
				)
			).SecretString
		: env.OPENROUTER_API_KEY;
	if (!token) throw new Error("OpenRouter API key is missing");
	return token;
}
