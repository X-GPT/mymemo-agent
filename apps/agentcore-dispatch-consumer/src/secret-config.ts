import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

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

/**
 * Materialize the agent-worker's passwordless RDS URL with the current RDS
 * master-secret password, then pin certificate verification for AgentCore.
 */
export function resolveVerifiedAgentDatabaseUrl(
	passwordlessUrl: string,
	passwordSecret: string,
): string {
	let url: URL;
	try {
		url = new URL(passwordlessUrl);
	} catch {
		throw new Error(
			"AGENT_DATABASE_URL must be a PostgreSQL URL without a password",
		);
	}
	if (
		(url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
		!url.hostname ||
		!url.username ||
		url.password
	) {
		throw new Error(
			"AGENT_DATABASE_URL must be a PostgreSQL URL without a password",
		);
	}

	let password: unknown;
	try {
		password = (JSON.parse(passwordSecret) as { password?: unknown }).password;
	} catch {
		throw new Error("DB_PASSWORD secret must contain a JSON password");
	}
	if (typeof password !== "string" || !password) {
		throw new Error("DB_PASSWORD secret must contain a JSON password");
	}

	url.password = password;
	url.searchParams.set("sslmode", "verify-full");
	return verifiedDatabaseUrl(url.toString(), "AGENT_DATABASE_URL");
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
