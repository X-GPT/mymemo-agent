import { readFile } from "node:fs/promises";
import { requireEnv } from "agentcore-canary-dispatch/config-utils";
import {
	type CurrentSecretReader,
	createAwsCurrentSecretReader,
	resolveCanaryDatabaseUrlsFromSecretArns,
} from "agentcore-canary-dispatch/secret-config";
import { Client, type ClientConfig } from "pg";

type Env = Record<string, string | undefined>;

interface PreflightDependencies {
	readCurrentSecret: CurrentSecretReader;
	readCaBundle(path: string): Promise<string>;
	connect(name: string, url: string, ca: string): Promise<void>;
}

async function connectWithVerifiedTls(
	name: string,
	url: string,
	ca: string,
): Promise<void> {
	const client = new Client(verifiedTlsPgConfig(url, ca));
	try {
		await client.connect();
		await client.query("SELECT 1");
	} catch (error) {
		throw new Error(`${name} verified TLS connectivity failed`, {
			cause: error,
		});
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
	const caPath = requireEnv(env, "RDS_CA_BUNDLE_PATH");
	const { agentDatabaseUrl, kbDatabaseUrl } =
		await resolveCanaryDatabaseUrlsFromSecretArns(
			env,
			dependencies.readCurrentSecret,
		);
	const ca = await dependencies.readCaBundle(caPath);

	await Promise.all([
		dependencies.connect("agentDatabase", agentDatabaseUrl, ca),
		dependencies.connect("kbDatabase", kbDatabaseUrl, ca),
	]);

	// Both flags are reachable only after both verified-TLS connections resolve.
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
