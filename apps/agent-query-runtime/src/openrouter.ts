import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

type Env = Record<string, string | undefined>;

export type ClaudeEnvironment = {
	ANTHROPIC_AUTH_TOKEN: string;
	ANTHROPIC_BASE_URL: string;
	ANTHROPIC_API_KEY: "";
};

async function readCurrentSecret(arn: string, region: string): Promise<string> {
	const client = new SecretsManagerClient({ region });
	try {
		const result = await client.send(
			new GetSecretValueCommand({ SecretId: arn, VersionStage: "AWSCURRENT" }),
		);
		if (!result.SecretString)
			throw new Error("OpenRouter secret has no string value");
		return result.SecretString;
	} finally {
		client.destroy();
	}
}

export async function resolveClaudeEnvironment(
	env: Env,
	readSecret = readCurrentSecret,
): Promise<ClaudeEnvironment> {
	const arn = env.OPENROUTER_API_KEY_SECRET_ARN?.trim();
	if (!arn) {
		const token = env.ANTHROPIC_AUTH_TOKEN?.trim();
		const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
		if (!token || !baseUrl) {
			throw new Error(
				"ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are required",
			);
		}
		return {
			ANTHROPIC_AUTH_TOKEN: token,
			ANTHROPIC_BASE_URL: baseUrl,
			ANTHROPIC_API_KEY: "",
		};
	}
	if (
		env.OPENROUTER_API_KEY ||
		env.ANTHROPIC_AUTH_TOKEN ||
		env.ANTHROPIC_API_KEY
	) {
		throw new Error("OpenRouter credentials must be read from Secrets Manager");
	}
	const region = env.AWS_REGION?.trim();
	if (!region) throw new Error("AWS_REGION is required");
	const baseUrl = env.OPENROUTER_BASE_URL?.trim();
	if (!baseUrl) throw new Error("OPENROUTER_BASE_URL is required");

	return {
		ANTHROPIC_AUTH_TOKEN: await readSecret(arn, region),
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: "",
	};
}
