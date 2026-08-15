import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const SECRET_ARN_PATTERN =
	/^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export type CurrentSecretReader = (arn: string) => Promise<string>;

export function exactSecretArn(
	value: string | undefined,
	name: string,
): string {
	if (!value || !SECRET_ARN_PATTERN.test(value)) {
		throw new Error(`${name} must be an exact Secrets Manager ARN`);
	}
	return value;
}

export function verifiedDatabaseUrl(value: string, name: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must use sslmode=verify-full`);
	}
	if (
		(url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
		!url.hostname ||
		url.searchParams.get("sslmode") !== "verify-full"
	) {
		throw new Error(`${name} must use sslmode=verify-full`);
	}
	return value;
}

export function createAwsCurrentSecretReader(
	region: string,
): CurrentSecretReader {
	const client = new SecretsManagerClient({ region });
	return async (arn) => {
		const response = await client.send(
			new GetSecretValueCommand({ SecretId: arn, VersionStage: "AWSCURRENT" }),
		);
		if (!response.SecretString) {
			throw new Error(`Secret ${arn} has no SecretString`);
		}
		return response.SecretString;
	};
}
