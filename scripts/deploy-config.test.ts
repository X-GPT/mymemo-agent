import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMaintenanceConfigFromEnv } from "../apps/agent-maintenance/src/config";
import { loadWorkerConfigFromEnv } from "../apps/agent-worker/src/config/env";
import { loadApiConfigFromEnv } from "../apps/chat-api/src/config/env";

const root = process.cwd();

describe("agent deployment behavior", () => {
	it("writes a Terraform-formatted generated image overlay", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mymemo-deploy-tfvars-"));
		const generatedTfvars = join(tempDir, "generated.auto.tfvars");

		try {
			const result = Bun.spawnSync({
				cmd: [
					join(root, "scripts", "deploy", "ci_prepare_tfvars.sh"),
					generatedTfvars,
				],
				cwd: root,
				env: {
					...process.env,
					AWS_REGION: "us-west-2",
					DEPLOY_ENVIRONMENT: "prod",
					CHAT_API_IMAGE: "example.test/chat-api:release-test",
					AGENT_MAINTENANCE_IMAGE:
						"example.test/agent-maintenance:release-test",
					AGENTCORE_DISPATCH_PUBLISHER_IMAGE:
						"example.test/agentcore-dispatch-publisher:release-test",
				},
			});

			expect(result.exitCode).toBe(0);
			const lines = readFileSync(generatedTfvars, "utf8").trimEnd().split("\n");
			const equalsColumns = lines.map((line) => line.indexOf("="));
			expect(lines).toHaveLength(4);
			expect(new Set(equalsColumns).size).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts the production deployment shape in all app config loaders", () => {
		const common = {
			AGENT_DATABASE_URL:
				"postgresql://agent:agent@db.example.com:5432/mymemo_agent",
			ARTIFACT_BUCKET: "mymemo-agent-prod-artifacts",
			AWS_REGION: "us-west-2",
			DB_SSL: "require",
			DB_PASSWORD: undefined,
			LOG_LEVEL: "info",
			E2B_API_KEY: "e2b_test_key",
			REDIS_URL: "rediss://default:secret@redis.example.com:6379",
		};

		expect(() =>
			loadApiConfigFromEnv({
				...common,
				STATSIG_SERVER_SECRET: "statsig-test-secret",
				E2B_TEMPLATE: "sandbox-template-prod",
			}),
		).not.toThrow();

		expect(() =>
			loadWorkerConfigFromEnv({
				...common,
				KB_DATABASE_URL: "postgresql://kb:kb@db.example.com:5432/mymemo_kb",
				OPENROUTER_API_KEY: "openrouter-test-key",
				OPENROUTER_BASE_URL: "https://openrouter.ai/api",
				OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4",
				WORKER_E2B_TEMPLATE: "mymemo-agent-sandbox",
			}),
		).not.toThrow();

		expect(() => loadMaintenanceConfigFromEnv(common)).not.toThrow();
	});
});
