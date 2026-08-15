import { readFile } from "node:fs/promises";
import {
	type CurrentSecretReader,
	createAwsCurrentSecretReader,
	exactSecretArn,
	verifiedDatabaseUrl,
} from "agentcore-canary-dispatch/secret-config";
import { Client, type ClientConfig } from "pg";

type Env = Record<string, string | undefined>;

interface PreflightDependencies {
	readCurrentSecret: CurrentSecretReader;
	readCaBundle(path: string): Promise<string>;
	connect(name: string, url: string, ca: string): Promise<void>;
}

function requireEnv(env: Env, name: string): string {
	const value = env[name];
	if (!value || value.trim() === "") throw new Error(`${name} is required`);
	return value;
}

async function connectWithVerifiedTls(
	_name: string,
	url: string,
	ca: string,
): Promise<void> {
	const client = new Client(verifiedTlsPgConfig(url, ca));
	try {
		await client.connect();
		await client.query("SELECT 1");
	} finally {
		await client.end().catch(() => undefined);
	}
}

export function verifiedTlsPgConfig(url: string, ca: string): ClientConfig {
	const connectionUrl = new URL(url);
	for (const parameter of [
		"ssl",
		"sslcert",
		"sslkey",
		"sslmode",
		"sslnegotiation",
		"sslrootcert",
	]) {
		connectionUrl.searchParams.delete(parameter);
	}
	return {
		connectionString: connectionUrl.toString(),
		connectionTimeoutMillis: 10_000,
		statement_timeout: 5_000,
		ssl: { ca, rejectUnauthorized: true },
	};
}

/**
 * Connectivity-only preflight. It reads secret values only inside the Lambda,
 * opens verified TLS connections, and has no dependency on Run admission.
 */
export async function runCanaryNetworkPreflight(
	env: Env,
	dependencies: PreflightDependencies,
) {
	const agentArn = exactSecretArn(
		env.CANARY_AGENT_DATABASE_URL_SECRET_ARN,
		"CANARY_AGENT_DATABASE_URL_SECRET_ARN",
	);
	const kbArn = exactSecretArn(
		env.CANARY_KB_DATABASE_URL_SECRET_ARN,
		"CANARY_KB_DATABASE_URL_SECRET_ARN",
	);
	const caPath = requireEnv(env, "RDS_CA_BUNDLE_PATH");
	const [rawAgentUrl, rawKbUrl] = await Promise.all([
		dependencies.readCurrentSecret(agentArn),
		dependencies.readCurrentSecret(kbArn),
	]);
	const agentUrl = verifiedDatabaseUrl(rawAgentUrl, "AGENT_DATABASE_URL");
	const kbUrl = verifiedDatabaseUrl(rawKbUrl, "KB_DATABASE_URL");
	const ca = await dependencies.readCaBundle(caPath);

	await Promise.all([
		dependencies.connect("agentDatabase", agentUrl, ca),
		dependencies.connect("kbDatabase", kbUrl, ca),
	]);

	return {
		health: "ok" as const,
		agentDatabaseTls: true,
		kbDatabaseTls: true,
		runAdmitted: false,
	};
}

export async function preflightHandler() {
	const region = requireEnv(process.env, "AWS_REGION");
	return await runCanaryNetworkPreflight(process.env, {
		readCurrentSecret: createAwsCurrentSecretReader(region),
		readCaBundle: async (path) => await readFile(path, "utf8"),
		connect: connectWithVerifiedTls,
	});
}
