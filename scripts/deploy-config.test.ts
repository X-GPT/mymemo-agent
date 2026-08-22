import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMaintenanceConfigFromEnv } from "../apps/agent-maintenance/src/config";
import { loadWorkerConfigFromEnv } from "../apps/agent-worker/src/config/env";
import { loadApiConfigFromEnv } from "../apps/chat-api/src/config/env";

const root = process.cwd();

function classifyMigrationPlan(terraformShowOutput: string) {
	const tempDir = mkdtempSync(join(tmpdir(), "mymemo-migration-plan-"));
	const terraform = join(tempDir, "terraform");

	writeFileSync(
		terraform,
		`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" != "-chdir=infra/terraform show -no-color fixture.tfplan" ]]; then
	exit 97
fi
printf '%s\\n' "\${TERRAFORM_SHOW_OUTPUT}"
`,
	);
	chmodSync(terraform, 0o755);

	try {
		return Bun.spawnSync({
			cmd: [
				join(root, "scripts", "deploy", "classify_migration_plan.sh"),
				"fixture.tfplan",
			],
			cwd: root,
			env: {
				...process.env,
				PATH: `${tempDir}:${process.env.PATH ?? ""}`,
				TERRAFORM_SHOW_OUTPUT: terraformShowOutput,
			},
		});
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("agent deployment behavior", () => {
	it("classifies migration-only plans without decoding stale prior state", () => {
		const migrationOnly = classifyMigrationPlan(`
  # data.aws_iam_policy_document.migration will be read during apply
  # aws_ecs_task_definition.agent_migration must be replaced

Plan: 1 to add, 0 to change, 1 to destroy.

Warning: Failed to decode resource from state
unsupported attribute "inference_accelerator"
`);

		expect(migrationOnly.exitCode).toBe(0);
		expect(migrationOnly.stdout.toString()).toContain("migration-only");

		const unexpectedChange = classifyMigrationPlan(`
  # aws_ecs_task_definition.agent_migration must be replaced
  # aws_iam_role.agent_migration_task will be updated in-place

Plan: 1 to add, 1 to change, 1 to destroy.
`);

		expect(unexpectedChange.exitCode).not.toBe(0);
		expect(unexpectedChange.stderr.toString()).toContain(
			"aws_iam_role.agent_migration_task",
		);
	});

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
					AGENT_WORKER_IMAGE: "example.test/agent-worker:release-test",
					AGENTCORE_DISPATCH_PUBLISHER_IMAGE:
						"example.test/agentcore-dispatch-publisher:release-test",
				},
			});

			expect(result.exitCode).toBe(0);
			const lines = readFileSync(generatedTfvars, "utf8").trimEnd().split("\n");
			const equalsColumns = lines.map((line) => line.indexOf("="));
			expect(lines).toHaveLength(5);
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
