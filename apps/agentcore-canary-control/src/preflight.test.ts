import { describe, expect, test } from "bun:test";
import { runCanaryNetworkPreflight, verifiedTlsPgConfig } from "./preflight";

const agentArn =
	"arn:aws:secretsmanager:us-west-2:637423444544:secret:agentcore/agent-db-AbCd12";
const kbArn =
	"arn:aws:secretsmanager:us-west-2:637423444544:secret:agentcore/kb-db-EfGh34";

describe("runCanaryNetworkPreflight", () => {
	test("passes the bundled CA explicitly instead of letting sslmode replace it", () => {
		expect(
			verifiedTlsPgConfig(
				"postgresql://readonly@example.internal/db?sslmode=verify-full",
				"trusted-rds-ca",
			),
		).toEqual({
			connectionString: "postgresql://readonly@example.internal/db",
			connectionTimeoutMillis: 10_000,
			statement_timeout: 5_000,
			ssl: { ca: "trusted-rds-ca", rejectUnauthorized: true },
		});
	});

	test("checks both exact AWSCURRENT database secrets with verified TLS and admits no Run", async () => {
		const reads: string[] = [];
		const connections: Array<{
			name: string;
			url: string;
			ca: string;
		}> = [];
		const result = await runCanaryNetworkPreflight(
			{
				CANARY_AGENT_DATABASE_URL_SECRET_ARN: agentArn,
				CANARY_KB_DATABASE_URL_SECRET_ARN: kbArn,
				RDS_CA_BUNDLE_PATH: "/var/task/rds-global-bundle.pem",
			},
			{
				readCurrentSecret: async (arn) => {
					reads.push(arn);
					return `postgresql://readonly@example.internal/db?sslmode=verify-full&source=${arn === agentArn ? "agent" : "kb"}`;
				},
				readCaBundle: async (path) => {
					expect(path).toBe("/var/task/rds-global-bundle.pem");
					return "trusted-rds-ca";
				},
				connect: async (name, url, ca) => {
					connections.push({ name, url, ca });
				},
			},
		);

		expect(reads).toEqual([agentArn, kbArn]);
		expect(connections).toEqual([
			{
				name: "agentDatabase",
				url: expect.stringContaining("source=agent"),
				ca: "trusted-rds-ca",
			},
			{
				name: "kbDatabase",
				url: expect.stringContaining("source=kb"),
				ca: "trusted-rds-ca",
			},
		]);
		expect(result).toEqual({
			health: "ok",
			agentDatabaseTls: true,
			kbDatabaseTls: true,
			runAdmitted: false,
		});
	});

	test("fails before connecting when either database weakens TLS", async () => {
		let connectionCount = 0;
		await expect(
			runCanaryNetworkPreflight(
				{
					CANARY_AGENT_DATABASE_URL_SECRET_ARN: agentArn,
					CANARY_KB_DATABASE_URL_SECRET_ARN: kbArn,
					RDS_CA_BUNDLE_PATH: "/var/task/rds-global-bundle.pem",
				},
				{
					readCurrentSecret: async (arn) =>
						arn === agentArn
							? "postgresql://readonly@example.internal/db?sslmode=require"
							: "postgresql://readonly@example.internal/db?sslmode=verify-full",
					readCaBundle: async () => "trusted-rds-ca",
					connect: async () => {
						connectionCount += 1;
					},
				},
			),
		).rejects.toThrow("AGENT_DATABASE_URL must use sslmode=verify-full");
		expect(connectionCount).toBe(0);
	});
});
