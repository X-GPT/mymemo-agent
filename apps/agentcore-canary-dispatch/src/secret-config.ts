import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Env } from "./config-utils";

const SECRET_ARN_PATTERN =
	/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export type CurrentSecretReader = (arn: string) => Promise<string>;

export interface SecretCommandClient {
	send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

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
		throw new Error(
			`${name} must be a PostgreSQL URL using sslmode=verify-full`,
		);
	}
	if (
		(url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
		!url.hostname
	) {
		throw new Error(
			`${name} must be a PostgreSQL URL using sslmode=verify-full`,
		);
	}
	if (url.searchParams.get("sslmode") !== "verify-full")
		throw new Error(`${name} must use sslmode=verify-full`);
	return value;
}

export function createCurrentSecretReader(
	client: SecretCommandClient,
): CurrentSecretReader {
	return async (arn) => {
		const response = await client.send(
			new GetSecretValueCommand({ SecretId: arn, VersionStage: "AWSCURRENT" }),
		);
		if (!response.SecretString) {
			throw new Error(`Secret ${arn} has no AWSCURRENT string value`);
		}
		return response.SecretString;
	};
}

export function createAwsCurrentSecretReader(
	region: string,
): CurrentSecretReader {
	return createCurrentSecretReader(new SecretsManagerClient({ region }));
}

export async function resolveCanaryDatabaseUrlsFromSecretArns(
	env: Env,
	readCurrentSecret: CurrentSecretReader,
): Promise<{ agentDatabaseUrl: string; kbDatabaseUrl: string }> {
	const agentArn = exactSecretArn(
		env.AGENT_DATABASE_URL_SECRET_ARN,
		"AGENT_DATABASE_URL_SECRET_ARN",
	);
	const kbArn = exactSecretArn(
		env.KB_DATABASE_URL_SECRET_ARN,
		"KB_DATABASE_URL_SECRET_ARN",
	);
	const [agentDatabaseUrl, kbDatabaseUrl] = await Promise.all([
		readCurrentSecret(agentArn),
		readCurrentSecret(kbArn),
	]);
	return {
		agentDatabaseUrl: verifiedDatabaseUrl(
			agentDatabaseUrl,
			"AGENT_DATABASE_URL",
		),
		kbDatabaseUrl: verifiedDatabaseUrl(kbDatabaseUrl, "KB_DATABASE_URL"),
	};
}
