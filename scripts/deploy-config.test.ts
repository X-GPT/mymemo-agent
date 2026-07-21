import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkerConfigFromEnv } from "../apps/agent-worker/src/config/env";
import { loadApiConfigFromEnv } from "../apps/chat-api/src/config/env";

const root = process.cwd();
const terraformDir = join(root, "infra", "terraform");
const ecrTerraformDir = join(root, "infra", "ecr");
const bootstrapIamTerraformDir = join(root, "infra", "bootstrap-iam");
const bootstrapIamProdTfvars = readFileSync(
	join(bootstrapIamTerraformDir, "prod.tfvars"),
	"utf8",
);
const exampleTfvars = readFileSync(
	join(terraformDir, "examples", "prod.tfvars.example"),
	"utf8",
);
const prodDeployEnv = readFileSync(join(root, "infra", "deploy", "prod.env"), "utf8");
const prodTfvars = readFileSync(join(terraformDir, "prod.tfvars"), "utf8");
const prodSecretsExample = readFileSync(
	join(root, "infra", "deploy", "prod.secrets.env.example"),
	"utf8",
);
const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
const releaseDeployWorkflow = readFileSync(
	join(root, ".github", "workflows", "release-deploy.yml"),
	"utf8",
);
const ciWorkflow = readFileSync(
	join(root, ".github", "workflows", "ci.yml"),
	"utf8",
);
const composeConfig = readFileSync(join(root, "compose.yaml"), "utf8");
const redisContractTest = readFileSync(
	join(
		root,
		"packages",
		"live-text",
		"src",
		"redis-live-stream-store.contract.test.ts",
	),
	"utf8",
);
const createAgentSecretsScript = readFileSync(
	join(root, "scripts", "deploy", "create_agent_secrets.sh"),
	"utf8",
);
const artifactOperationsRunbook = readFileSync(
	join(root, "docs", "runbooks", "downloadable-artifacts.md"),
	"utf8",
);

function terraformFiles(dir = terraformDir): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return terraformFiles(path);
		return entry.name.endsWith(".tf") ? [path] : [];
	});
}

describe("agent deployment config", () => {
	it("does not define a new VPC in mymemo-agent Terraform", () => {
		const combined = terraformFiles()
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(combined).not.toMatch(/resource\s+"aws_vpc"/);
		expect(combined).not.toMatch(/resource\s+"aws_subnet"/);
		expect(combined).toContain('data "terraform_remote_state" "mymemo_service"');
		expect(combined).toContain("shared_ecs_subnet_ids");
	});

	it("separates application task roles and grants least-privilege artifact access", () => {
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");
		const iamConfig = readFileSync(join(terraformDir, "iam.tf"), "utf8");
		const workerArtifactPolicy = iamConfig.slice(
			iamConfig.indexOf(
				'data "aws_iam_policy_document" "agent_worker_artifact_write"',
			),
			iamConfig.indexOf(
				'resource "aws_iam_role_policy" "agent_worker_artifact_write"',
			),
		);
		const terraformConfig = terraformFiles()
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");
		const taskRoles = [
			"chat_api_task",
			"agent_worker_task",
			"agent_migration_task",
		];

		expect(ecsConfig).toMatch(
			/resource "aws_ecs_task_definition" "chat_api" \{[\s\S]*?execution_role_arn\s*=\s*aws_iam_role\.task_execution\.arn[\s\S]*?task_role_arn\s*=\s*aws_iam_role\.chat_api_task\.arn/,
		);
		expect(ecsConfig).toMatch(
			/resource "aws_ecs_task_definition" "agent_worker" \{[\s\S]*?execution_role_arn\s*=\s*aws_iam_role\.task_execution\.arn[\s\S]*?task_role_arn\s*=\s*aws_iam_role\.agent_worker_task\.arn/,
		);
		expect(ecsConfig).toMatch(
			/resource "aws_ecs_task_definition" "agent_migration" \{[\s\S]*?execution_role_arn\s*=\s*aws_iam_role\.task_execution\.arn[\s\S]*?task_role_arn\s*=\s*aws_iam_role\.agent_migration_task\.arn/,
		);
		expect(
			ecsConfig.match(
				/execution_role_arn\s*=\s*aws_iam_role\.task_execution\.arn/g,
			),
		).toHaveLength(3);

		for (const role of taskRoles) {
			expect(iamConfig).toContain(`resource "aws_iam_role" "${role}"`);
			expect(
				terraformConfig.match(
					new RegExp(`\\baws_iam_role\\.${role}\\.(?:arn|id|name)\\b`, "g"),
				),
			).toHaveLength(
				role === "chat_api_task" || role === "agent_worker_task" ? 2 : 1,
			);
		}
		expect(iamConfig).not.toContain('resource "aws_iam_role" "task"');
		expect(iamConfig).toContain('actions   = ["s3:GetObject"]');
		expect(iamConfig).toContain("role   = aws_iam_role.chat_api_task.id");
		expect(workerArtifactPolicy).toMatch(
			/actions\s*=\s*\[\s*"s3:AbortMultipartUpload",\s*"s3:DeleteObject",\s*"s3:PutObject",\s*\]/,
		);
		expect(iamConfig).toContain("role   = aws_iam_role.agent_worker_task.id");
		expect(iamConfig).toMatch(
			/data "aws_iam_policy_document" "agent_worker_artifact_write" \{[\s\S]*?actions\s*=\s*\[\s*"s3:AbortMultipartUpload",\s*"s3:DeleteObject",\s*"s3:PutObject",\s*\][\s\S]*?resources\s*=\s*\["\$\{aws_s3_bucket\.artifacts\.arn\}\/\*"\][\s\S]*?\}/,
		);
		expect(workerArtifactPolicy).not.toMatch(
			/s3:(GetObject|ListBucket|DeleteObjectVersion|GetObjectVersion|ListBucketVersions)/,
		);
		expect(iamConfig).not.toMatch(
			/role\s*=\s*aws_iam_role\.agent_migration_task\.(?:id|name)[\s\S]*?s3:/,
		);
		expect(
			iamConfig.match(/role\s*=\s*aws_iam_role\.task_execution\.(?:name|id)/g),
		).toHaveLength(2);
	});

	it("provisions the private Downloadable artifact bucket and task access", () => {
		const artifactsConfig = readFileSync(
			join(terraformDir, "artifacts.tf"),
			"utf8",
		);
		const iamConfig = readFileSync(join(terraformDir, "iam.tf"), "utf8");
		const locals = readFileSync(join(terraformDir, "locals.tf"), "utf8");
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");
		const migrationStart = ecsConfig.indexOf(
			'resource "aws_ecs_task_definition" "agent_migration"',
		);
		const migrationConfig = ecsConfig.slice(migrationStart);
		const chatEnvironmentStart = locals.indexOf("chat_api_environment");
		const workerEnvironmentStart = locals.indexOf("agent_worker_environment");
		const chatEnvironment = locals.slice(
			chatEnvironmentStart,
			workerEnvironmentStart,
		);
		const workerEnvironment = locals.slice(workerEnvironmentStart);
		const terraformConfig = terraformFiles()
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(artifactsConfig).toContain('resource "aws_s3_bucket" "artifacts"');
		expect(artifactsConfig).toMatch(
			/resource "aws_s3_bucket_public_access_block" "artifacts"[\s\S]*?block_public_acls\s*=\s*true[\s\S]*?block_public_policy\s*=\s*true[\s\S]*?ignore_public_acls\s*=\s*true[\s\S]*?restrict_public_buckets\s*=\s*true/,
		);
		expect(artifactsConfig).toMatch(
			/resource "aws_s3_bucket_ownership_controls" "artifacts"[\s\S]*?object_ownership\s*=\s*"BucketOwnerEnforced"/,
		);
		expect(artifactsConfig).toMatch(
			/resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts"[\s\S]*?sse_algorithm\s*=\s*"AES256"/,
		);
		expect(artifactsConfig).toMatch(
			/resource "aws_s3_bucket_versioning" "artifacts"[\s\S]*?status\s*=\s*"Disabled"/,
		);
		expect(artifactsConfig).toMatch(
			/resource "aws_s3_bucket_lifecycle_configuration" "artifacts"[\s\S]*?id\s*=\s*"abort-incomplete-multipart-uploads"[\s\S]*?status\s*=\s*"Enabled"[\s\S]*?abort_incomplete_multipart_upload[\s\S]*?days_after_initiation\s*=\s*1/,
		);
		expect(terraformConfig).not.toMatch(
			/\b(?:expiration|noncurrent_version_expiration|expired_object_delete_marker)\b/,
		);
		expect(artifactsConfig).toContain('variable = "aws:SecureTransport"');
		expect(artifactsConfig).toContain('values   = ["false"]');
		expect(terraformConfig).not.toContain("aws_s3_bucket_cors_configuration");
		expect(terraformConfig).not.toMatch(/\bcors_rule\s*\{/);
		expect(terraformConfig).not.toMatch(
			/aws_kms|kms_master_key_id|SSEKMSKeyId/,
		);
		expect(
			terraformConfig.match(/resource\s+"aws_s3_bucket_versioning"/g),
		).toHaveLength(1);
		expect(terraformConfig).not.toMatch(/\bversioning\s*\{/);

		expect(iamConfig).toContain('actions   = ["s3:GetObject"]');
		expect(iamConfig).toContain(
			'resources = ["${aws_s3_bucket.artifacts.arn}/*"]',
		);
		expect(chatEnvironment).toContain('{ name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket }');
		expect(chatEnvironment).toContain('{ name = "AWS_REGION", value = var.aws_region }');
		expect(workerEnvironment).toContain('{ name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket }');
		expect(workerEnvironment).toContain('{ name = "AWS_REGION", value = var.aws_region }');
		expect(migrationConfig).not.toContain("ARTIFACT_BUCKET");
	});

	it("provisions the authenticated TLS Redis Live Stream inside the trusted service network", () => {
		const redisConfig = readFileSync(join(terraformDir, "redis.tf"), "utf8");
		const locals = readFileSync(join(terraformDir, "locals.tf"), "utf8");
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");
		const outputs = readFileSync(join(terraformDir, "outputs.tf"), "utf8");
		const migrationStart = ecsConfig.indexOf(
			'resource "aws_ecs_task_definition" "agent_migration"',
		);
		const migrationEnd = ecsConfig.indexOf(
			'resource "aws_ecs_service" "chat_api"',
			migrationStart,
		);
		const migrationConfig = ecsConfig.slice(migrationStart, migrationEnd);

		expect(redisConfig).toContain(
			'resource "aws_elasticache_replication_group" "live"',
		);
		expect(redisConfig).toMatch(/num_cache_clusters\s*=\s*1/);
		expect(redisConfig).toMatch(/automatic_failover_enabled\s*=\s*false/);
		expect(redisConfig).toMatch(/multi_az_enabled\s*=\s*false/);
		expect(redisConfig).toMatch(/snapshot_retention_limit\s*=\s*0/);
		expect(redisConfig).toMatch(/transit_encryption_enabled\s*=\s*true/);
		expect(redisConfig).toMatch(/transit_encryption_mode\s*=\s*"required"/);
		expect(redisConfig).toMatch(/at_rest_encryption_enabled\s*=\s*true/);
		expect(redisConfig).toMatch(/auth_token\s*=\s*random_password\.live_redis\.result/);
		expect(redisConfig).toContain("subnet_ids = local.shared_ecs_subnet_ids");
		expect(redisConfig).toContain(
			"source_security_group_id = aws_security_group.live_redis_clients.id",
		);
		expect(redisConfig).not.toMatch(/\b(?:cidr_blocks|ipv6_cidr_blocks)\b/);
		expect(redisConfig).toContain(
			'resource "aws_secretsmanager_secret" "live_redis_url"',
		);
		expect(redisConfig).toContain(
			'"rediss://default:${urlencode(random_password.live_redis.result)}@',
		);
		expect(locals.match(/name\s*=\s*"REDIS_URL"/g)).toHaveLength(1);
		expect(locals).toMatch(
			/live_redis_url_secret\s*=\s*var\.live_stream_enabled\s*\?/,
		);
		expect(
			locals.match(
				/\],\s*local\.live_redis_url_secret,\s*local\.agent_db_password_secret\)/g,
			),
		).toHaveLength(2);
		expect(ecsConfig.match(/aws_security_group\.live_redis_clients\.id/g)).toHaveLength(2);
		expect(migrationConfig).toContain("secrets = local.agent_db_password_secret");
		expect(migrationConfig).not.toContain("REDIS_URL");
		expect(outputs).not.toMatch(/live_redis|REDIS_URL|random_password/);
	});

	it("keeps the Redis Live Stream additively deployable until the hard cutover", () => {
		const readme = readFileSync(join(terraformDir, "README.md"), "utf8");

		expect(readme).toContain(
			"Redis availability must not participate in chat-api or agent-worker readiness",
		);
		expect(readme).toContain(
			"The durable Postgres path remains sufficient for successful Runs",
		);
		expect(readme).toContain("live_stream_enabled=false");
	});

	it("provides disposable local and CI Redis for real Stream and Lua contract tests", () => {
		expect(composeConfig).toMatch(/\n {2}redis:\n[\s\S]*?image: redis:7/);
		expect(composeConfig).toContain('"127.0.0.1:${REDIS_PORT:-6379}:6379"');
		expect(composeConfig).toContain(
			'["redis-server", "--save", "", "--appendonly", "no"]',
		);
		expect(composeConfig).not.toMatch(/redis-data|redisdata/);
		expect(ciWorkflow).toContain("redis-server");
		expect(ciWorkflow).toContain("bun run test");
		expect(redisContractTest).toContain('"redis-server"');
	});

	it("documents the Downloadable artifact operator and downstream contracts", () => {
		for (const requiredContract of [
			"ARTIFACT_BUCKET",
			"AWS_REGION",
			"/home/user/artifacts/",
			"100 MiB",
			"100 current artifact paths",
			"1 GiB",
			"five minutes",
			"ten minutes",
			"conversation lifetime",
			"Run failed",
			"Content-Disposition: attachment",
			"untrusted generated files",
			"mymemo-service",
			"mymemo-web",
			"downloadUrl",
			"normal browser navigation",
		]) {
			expect(artifactOperationsRunbook).toContain(requiredContract);
		}
		expect(artifactOperationsRunbook).toMatch(
			/With same-origin\s+session-cookie authentication/,
		);
		expect(artifactOperationsRunbook).toContain(
			"With bearer-header authentication",
		);
	});

	it("alarms on sustained payload-free Live signals without health coupling", () => {
		const cloudwatch = readFileSync(join(terraformDir, "cloudwatch.tf"), "utf8");
		const ecs = readFileSync(join(terraformDir, "ecs.tf"), "utf8");

		for (const resource of [
			"live_preview_degraded",
			"live_preview_widespread_degraded",
			"live_preview_drops",
			"live_preview_overflow",
		]) {
			expect(cloudwatch).toContain(
				`resource "aws_cloudwatch_metric_alarm" "${resource}"`,
			);
		}
		expect(cloudwatch.match(/datapoints_to_alarm\s*=\s*2/g)).toHaveLength(7);
		expect(cloudwatch).toMatch(
			/resource "aws_cloudwatch_metric_alarm" "live_preview_widespread_degraded"[\s\S]*?evaluation_periods\s*=\s*3[\s\S]*?datapoints_to_alarm\s*=\s*2[\s\S]*?threshold\s*=\s*2/,
		);
		expect(cloudwatch).toContain(
			'expression  = "IF(FILL(chat, 0) > 0, 1, 0) + IF(FILL(worker, 0) > 0, 1, 0)"',
		);
		expect(
			cloudwatch.match(/evaluation_periods\s*=\s*3/g)?.length,
		).toBeGreaterThanOrEqual(3);
		expect(cloudwatch).toContain('treat_missing_data  = "notBreaching"');
		expect(cloudwatch).toContain('Service = "$.service"');
		expect(cloudwatch).toContain('Signal  = "$.signal"');
		expect(cloudwatch).toContain('Outcome = "$.outcome"');
		expect(cloudwatch).not.toMatch(
			/ConversationId|RunId|MessageId|text|payload|REDIS_URL/,
		);
		expect(ecs).not.toMatch(
			/live_preview_(degraded|drops|overflow)|LivePreview/,
		);
	});

	it("alarms on retained Live Stream unavailability, recovery, and capacity exhaustion", () => {
		const cloudwatch = readFileSync(join(terraformDir, "cloudwatch.tf"), "utf8");
		const ecs = readFileSync(join(terraformDir, "ecs.tf"), "utf8");

		for (const filter of [
			"live_stream_operations",
			"live_stream_latency",
			"live_stream_redis_unavailable",
			"live_stream_recovery",
			"live_stream_capacity",
			"live_stream_degraded_duration",
		]) {
			expect(cloudwatch).toContain(
				`resource "aws_cloudwatch_log_metric_filter" "${filter}"`,
			);
		}
		for (const alarm of [
			"live_stream_redis_unavailable",
			"live_stream_recovery_rate",
			"live_stream_capacity_bound",
		]) {
			expect(cloudwatch).toContain(
				`resource "aws_cloudwatch_metric_alarm" "${alarm}"`,
			);
		}
		expect(cloudwatch).toContain("Live Stream metric");
		expect(cloudwatch).toContain("agent-worker owns Live Stream production");
		expect(cloudwatch).toContain("chat-api owns reconnect and recovery responses");
		expect(cloudwatch).toContain('namespace = "${local.common_name}/LiveStream"');
		expect(cloudwatch).toContain('treat_missing_data  = "notBreaching"');
		expect(cloudwatch).toContain('Result    = "$.result"');
		expect(cloudwatch).not.toMatch(
			/LiveStream[\s\S]*?(ConversationId|RunId|MessageId|RedisKey|Payload)/,
		);
		expect(ecs).not.toContain("LiveStream");
	});

	it("example tfvars include required deploy inputs and optional secret-name overrides", () => {
		for (const required of [
			"assign_public_ip",
			"agent_db_instance_class",
			"mymemo_service_api_security_group_ids",
			"kb_database_security_group_id",
			"kb_database_url_secret_name",
			"statsig_server_secret_name",
			"openrouter_api_key_secret_name",
			"e2b_api_key_secret_name",
			"live_redis_node_type",
			"live_redis_engine_version",
		]) {
			expect(exampleTfvars).toContain(required);
		}
	});

	it("agent deploy config does not duplicate shared mymemo-service IDs", () => {
		for (const forbidden of [
			"VPC_ID=",
			"PRIVATE_SUBNET_IDS=",
			"ECS_CLUSTER_ARN=",
			"ALB_LISTENER_ARN=",
			"ALB_SECURITY_GROUP_ID=",
			"vpc-05772c7f2f628c024",
			"sg-0871613142f607a90",
			"mymemo-staging-cluster",
			"mymemo-staging-alb/acf2230a5f2f6afb/136a14cb4f1792d9",
		]) {
			expect(prodDeployEnv).not.toContain(forbidden);
		}
	});

	it("example tfvars do not contain literal secret values", () => {
		expect(exampleTfvars).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(exampleTfvars).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
		expect(exampleTfvars).not.toMatch(/LLM_TOKEN_SECRET\s*=/);
		expect(exampleTfvars).not.toMatch(/OPENROUTER_API_KEY\s*=/);
		expect(exampleTfvars).not.toMatch(/E2B_API_KEY\s*=/);
		expect(exampleTfvars).not.toMatch(/STATSIG_SERVER_SECRET\s*=/);
	});

	it("checked-in prod tfvars owns repeatable Terraform inputs", () => {
		for (const required of [
			'environment = "prod"',
			"assign_public_ip = true",
			'mymemo_service_api_security_group_ids = ["sg-05d48e36ef8966c9e"]',
			'kb_database_security_group_id = "sg-0c7084b87f3e109d7"',
			'openrouter_default_model   = "anthropic/claude-sonnet-4"',
			'worker_e2b_template        = "mymemo-agent-sandbox"',
		]) {
			expect(prodTfvars).toContain(required);
		}
		expect(prodTfvars).not.toContain("agent_alb_certificate_arn");
		expect(prodTfvars).not.toContain("aws_region");
		expect(prodTfvars).not.toContain("gateway_public_url");
		expect(prodTfvars).toContain("mymemo-agent-prod-KB_DATABASE_URL");
		expect(prodTfvars).toContain(
			'alarm_action_arns = ["arn:aws:sns:us-west-2:637423444544:mymemo-staging-alarms"]',
		);
		expect(prodTfvars).not.toContain("CREATE_AGENT_DATABASE");
		expect(prodTfvars).not.toContain("AGENT_DATABASE_URL_SECRET_ARN");
		expect(prodTfvars).not.toContain("DB_PASSWORD_SECRET_ARN");
		expect(prodTfvars).not.toContain("_SECRET_ARN");
	});

	it("checked-in prod deploy env is limited to CI and smoke inputs", () => {
		for (const required of [
			"AWS_REGION=us-west-2",
			"AWS_ACCOUNT_ID=637423444544",
			"DEPLOY_ENVIRONMENT=prod",
			"AGENT_SMOKE_BASE_URL=REPLACE_ME_AGENT_SMOKE_BASE_URL",
			"AGENT_SMOKE_EXPECT_GATE_CLOSED=false",
			"AGENT_SMOKE_PREVIEW_MODE=required",
		]) {
			expect(prodDeployEnv).toContain(required);
		}
		for (const terraformOnly of [
			"ASSIGN_PUBLIC_IP=",
			"GATEWAY_PUBLIC_URL=",
			"OPENROUTER_DEFAULT_MODEL=",
			"AGENT_DB_INSTANCE_CLASS=",
			"CHAT_API_DESIRED_COUNT=",
		]) {
			expect(prodDeployEnv).not.toContain(terraformOnly);
		}
	});

	it("release deploy uses normal ECR terraform apply and not target apply", () => {
		const ecrCombined = terraformFiles(ecrTerraformDir)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(ecrCombined).toContain('resource "aws_ecr_repository" "chat_api"');
		expect(releaseDeployWorkflow).toContain("terraform -chdir=infra/ecr apply -auto-approve");
		expect(releaseDeployWorkflow).not.toContain("-target=");
		expect(releaseDeployWorkflow).not.toContain("bootstrap_ecr_repositories.sh");
	});

	it("release deploy does not rewrite long-lived application secrets", () => {
		expect(releaseDeployWorkflow).not.toContain("create_agent_secrets.sh");
		expect(releaseDeployWorkflow).not.toContain("LLM_TOKEN_SECRET_VALUE");
		expect(releaseDeployWorkflow).not.toContain("OPENROUTER_API_KEY_VALUE");
	});

	it("checked-in prod deploy env contains no literal secret values", () => {
		expect(prodDeployEnv).not.toContain("arn:aws:secretsmanager");
		expect(prodTfvars).not.toContain("arn:aws:secretsmanager");
		expect(prodDeployEnv).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(prodTfvars).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(prodDeployEnv).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
		expect(prodTfvars).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
		expect(prodDeployEnv).not.toMatch(/^LLM_TOKEN_SECRET=/m);
		expect(prodDeployEnv).not.toMatch(/^OPENROUTER_API_KEY=/m);
		expect(prodDeployEnv).not.toMatch(/^E2B_API_KEY=/m);
		expect(prodDeployEnv).not.toMatch(/^STATSIG_SERVER_SECRET=/m);
	});

	it("local secret bootstrap files are ignored and examples are empty", () => {
		expect(gitignore).toContain("infra/deploy/*.secrets.env");
		expect(gitignore).toContain("infra/terraform/generated.auto.tfvars");
		expect(prodSecretsExample).toContain("OPENROUTER_API_KEY_VALUE=");
		expect(prodSecretsExample).not.toMatch(/=. +/);
		expect(prodSecretsExample).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(prodSecretsExample).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
	});

	it("release deploy runs migrations before rolling ECS services", () => {
		const bootstrapPlanIndex = releaseDeployWorkflow.indexOf(
			"scripts/deploy/terraform_prod_in_place_plan.sh agent-bootstrap.tfplan",
		);
		const bootstrapApplyIndex = releaseDeployWorkflow.indexOf(
			"scripts/deploy/terraform_prod_in_place_apply.sh agent-bootstrap.tfplan",
		);
		const migrationIndex = releaseDeployWorkflow.indexOf(
			"scripts/deploy/run_agent_migration.sh",
		);
		const desiredPlanIndex = releaseDeployWorkflow.indexOf(
			"Terraform plan desired service counts",
		);
		const rolloutIndex = releaseDeployWorkflow.indexOf(
			"scripts/deploy/roll_ecs_services.sh",
		);

		expect(releaseDeployWorkflow).toContain("Detect first ECS service deploy");
		expect(releaseDeployWorkflow).toContain("scripts/deploy/detect_first_agent_deploy.sh");
		expect(releaseDeployWorkflow).toContain("BOOTSTRAP_ZERO_DESIRED_COUNT: true");
		expect(bootstrapPlanIndex).toBeGreaterThan(-1);
		expect(bootstrapApplyIndex).toBeGreaterThan(bootstrapPlanIndex);
		expect(migrationIndex).toBeGreaterThan(-1);
		expect(bootstrapApplyIndex).toBeLessThan(migrationIndex);
		expect(desiredPlanIndex).toBeGreaterThan(migrationIndex);
		expect(rolloutIndex).toBeGreaterThan(-1);
		expect(migrationIndex).toBeLessThan(rolloutIndex);
		expect(releaseDeployWorkflow).not.toContain("scripts/deploy/prod_smoke.sh");
	});

	it("terraform does not roll ECS services before migrations", () => {
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");
		const outputs = readFileSync(join(terraformDir, "outputs.tf"), "utf8");
		const rolloutScript = readFileSync(
			join(root, "scripts", "deploy", "roll_ecs_services.sh"),
			"utf8",
		);

		expect(ecsConfig).toContain("ignore_changes = [task_definition]");
		expect(outputs).toContain('output "chat_api_task_definition_arn"');
		expect(outputs).toContain('output "agent_worker_task_definition_arn"');
		expect(rolloutScript).toContain("terraform -chdir=infra/terraform output -raw chat_api_task_definition_arn");
		expect(rolloutScript).toContain("terraform -chdir=infra/terraform output -raw agent_worker_task_definition_arn");
		expect(rolloutScript).toContain('--task-definition "$chat_api_task_definition"');
		expect(rolloutScript).toContain('--task-definition "$agent_worker_task_definition"');
	});

	it("release deploy plans with checked-in Terraform tfvars plus generated image overlay", () => {
		const planScript = readFileSync(
			join(root, "scripts", "deploy", "terraform_prod_in_place_plan.sh"),
			"utf8",
		);
		const prepareScript = readFileSync(
			join(root, "scripts", "deploy", "ci_prepare_tfvars.sh"),
			"utf8",
		);

		expect(planScript).toContain('tfvars_file="${TFVARS_FILE:-infra/terraform/prod.tfvars}"');
		expect(planScript).toContain('generated_tfvars_file_abs=');
		expect(planScript).toContain('plan_args=(');
		expect(planScript).toContain('-var-file="$tfvars_file_abs"');
		expect(planScript).toContain('-var-file="$generated_tfvars_file_abs"');
		expect(planScript).toContain('BOOTSTRAP_ZERO_DESIRED_COUNT');
		expect(planScript).toContain('-var="chat_api_desired_count=0"');
		expect(planScript).toContain('-var="agent_worker_desired_count=0"');
		expect(planScript).toContain('terraform -chdir=infra/terraform plan "${plan_args[@]}" -out="$plan_file"');
		expect(planScript).toContain("generated.auto.tfvars");
		expect(releaseDeployWorkflow).toContain("uses: hashicorp/setup-terraform@v4");
		expect(releaseDeployWorkflow).toContain("terraform_wrapper: false");
		expect(prepareScript).toContain("aws_region");
		expect(prepareScript).toContain("chat_api_image");
		expect(prepareScript).not.toContain("gateway_public_url");
		expect(prepareScript).not.toContain("agent_db_instance_class");
		expect(prepareScript).not.toContain("DEPLOY_CONFIG");
		expect(prepareScript).not.toContain("prod.env");
		expect(prepareScript).toContain("terraform -chdir=infra/ecr output -raw chat_api_ecr_repository_url");
		expect(prepareScript).toContain("terraform -chdir=infra/ecr output -raw agent_worker_ecr_repository_url");
		expect(prepareScript).toContain("Set both CHAT_API_IMAGE and AGENT_WORKER_IMAGE");
		expect(releaseDeployWorkflow).not.toContain("AWS_REGION: us-west-2");
		expect(releaseDeployWorkflow).not.toContain('AWS_ACCOUNT_ID: "637423444544"');
		expect(releaseDeployWorkflow).toContain("Load deploy config");
		expect(releaseDeployWorkflow).toContain('source "${DEPLOY_CONFIG}"');
		expect(releaseDeployWorkflow).toContain('terraform -chdir=infra/ecr apply -auto-approve -var="aws_region=${AWS_REGION}"');
		expect(releaseDeployWorkflow).toContain(
			"arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:role/mymemo-agent-github-actions-deploy",
		);
		expect(releaseDeployWorkflow).toContain("DEPLOY_ENVIRONMENT: ${{ inputs.environment || 'prod' }}");
		expect(releaseDeployWorkflow).toContain("GITHUB_RUN_ATTEMPT");
		expect(releaseDeployWorkflow).toContain("type: choice");
		expect(releaseDeployWorkflow).toContain("- prod");
		expect(releaseDeployWorkflow).toContain("confirm_prod_apply");
		expect(releaseDeployWorkflow).not.toContain("gateway_public_url");
		expect(releaseDeployWorkflow).not.toContain("GATEWAY_PUBLIC_URL");
		// The phrase is auto-supplied only for the unattended app lane; the infra
		// lane still requires the operator-typed dispatch input.
		expect(releaseDeployWorkflow).toContain(
			"CONFIRM_AGENT_PROD_APPLY: ${{ needs.plan.outputs.lane == 'app' && 'apply-mymemo-agent-prod' || inputs.confirm_prod_apply }}",
		);
		expect(releaseDeployWorkflow).not.toContain("CONFIRM_AGENT_PROD_APPLY: apply-mymemo-agent-prod");
	});

	it("bootstrap IAM owns the agent-specific GitHub Actions deploy role", () => {
		const combined = terraformFiles(bootstrapIamTerraformDir)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(combined).toContain('default     = "mymemo-agent-github-actions-deploy"');
		expect(combined).toContain('variable "aws_region"');
		expect(combined).not.toContain('default     = "us-west-2"');
		expect(bootstrapIamProdTfvars).toMatch(/aws_region\s*=\s*"us-west-2"/);
		expect(combined).toContain('variable "aws_account_id"');
		expect(combined).not.toContain('default     = "637423444544"');
		expect(bootstrapIamProdTfvars).toMatch(
			/aws_account_id\s*=\s*"637423444544"/,
		);
		expect(combined).toContain("token.actions.githubusercontent.com:sub");
		// Ref-pinned, not environment-pinned: no GitHub environment features are
		// used (plan-gated on private repos) and only runs on main can assume
		// the deploy role.
		expect(combined).toContain("repo:${var.github_owner}/${var.github_repository}:ref:${var.github_deploy_ref}");
		expect(combined).toContain('default     = "refs/heads/main"');
		expect(combined).not.toContain(":environment:");
		expect(combined).toContain("sts:AssumeRoleWithWebIdentity");
		expect(combined).toContain("mymemo-agent/bootstrap-iam-prod.tfstate");
		expect(combined).not.toContain("mymemo-github-actions-deploy");
		expect(combined).toContain('"iam:ListInstanceProfilesForRole"');
		expect(combined).toContain('sid = "ArtifactBucketManagement"');
		for (const action of [
			"s3:CreateBucket",
			"s3:GetAccelerateConfiguration",
			"s3:GetLifecycleConfiguration",
			"s3:GetObjectLockConfiguration",
			"s3:GetReplicationConfiguration",
			"s3:PutLifecycleConfiguration",
			"s3:PutBucketOwnershipControls",
			"s3:PutBucketPolicy",
			"s3:PutBucketPublicAccessBlock",
			"s3:PutBucketTagging",
			"s3:PutBucketVersioning",
			"s3:PutEncryptionConfiguration",
		]) {
			expect(combined).toContain(`"${action}"`);
		}
		expect(combined).toContain(
			'"arn:aws:s3:::${var.artifact_bucket_name}"',
		);
		expect(bootstrapIamProdTfvars).toContain(
			'artifact_bucket_name = "mymemo-agent-prod-artifacts"',
		);
	});

	it("release deploy serializes runs and generates unique immutable image tags", () => {
		expect(releaseDeployWorkflow).toContain("concurrency:");
		expect(releaseDeployWorkflow).toContain("group: release-deploy-${{ inputs.environment || 'prod' }}");
		expect(releaseDeployWorkflow).toContain("cancel-in-progress: false");
		expect(releaseDeployWorkflow).not.toContain("inputs.image_tag");
		expect(releaseDeployWorkflow).not.toContain("REQUESTED_IMAGE_TAG");
		expect(releaseDeployWorkflow).toContain('image_tag="release-${short_sha}-${GITHUB_RUN_NUMBER}-${GITHUB_RUN_ATTEMPT}"');
		expect(releaseDeployWorkflow).toContain('if [[ ! "${image_tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]');
		expect(releaseDeployWorkflow).toContain("printf 'IMAGE_TAG=%s\\n'");
		expect(releaseDeployWorkflow).not.toContain('echo "IMAGE_TAG=${REQUESTED_IMAGE_TAG}" >> "${GITHUB_ENV}"');
	});

	it("release deploy auto-deploys CI-green main through classified lanes", () => {
		const classifyScript = readFileSync(
			join(root, "scripts", "deploy", "classify_terraform_plan.sh"),
			"utf8",
		);

		// Auto trigger: only a green CI run on main, deploying the exact commit
		// CI validated rather than main's tip at run time.
		expect(releaseDeployWorkflow).toContain("workflow_run:");
		expect(releaseDeployWorkflow).toContain("workflows: [CI]");
		expect(releaseDeployWorkflow).toContain("branches: [main]");
		expect(releaseDeployWorkflow).toContain("github.event.workflow_run.conclusion == 'success'");
		expect(releaseDeployWorkflow).toContain(
			"DEPLOY_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}",
		);
		expect(releaseDeployWorkflow).toContain("ref: ${{ env.DEPLOY_SHA }}");

		// App-only plans (the image-tag roll) apply unattended; infra plans fail
		// the automatic run and require a manual dispatch with the confirm phrase.
		expect(releaseDeployWorkflow).toContain("scripts/deploy/classify_terraform_plan.sh");
		expect(releaseDeployWorkflow).toContain(
			"if: needs.plan.outputs.lane == 'infra' && github.event_name != 'workflow_dispatch'",
		);
		expect(classifyScript).toContain('. != "aws_ecs_task_definition" and . != "aws_ecs_service"');
		expect(classifyScript).toContain('["no-op", "read"]');

		// The deploy job re-plans and re-classifies so drift between the jobs
		// cannot smuggle infra changes through the unattended lane.
		expect(releaseDeployWorkflow).toContain(
			"if: env.FIRST_DEPLOY != 'true' && needs.plan.outputs.lane == 'app'",
		);

		// No GitHub environment features anywhere (plan-gated on private repos);
		// the OIDC trust is ref-pinned instead.
		expect(releaseDeployWorkflow).not.toContain("\n    environment:");
	});

	it("agent RDS tracks the PostgreSQL major version for auto-minor upgrades", () => {
		const rdsConfig = readFileSync(join(terraformDir, "rds.tf"), "utf8");
		const variables = readFileSync(join(terraformDir, "variables.tf"), "utf8");
		const exampleTfvars = readFileSync(
			join(terraformDir, "examples", "prod.tfvars.example"),
			"utf8",
		);

		expect(rdsConfig).toContain("auto_minor_version_upgrade = true");
		expect(variables).toContain('default     = "17"');
		expect(prodTfvars).toContain('agent_db_engine_version           = "17"');
		expect(exampleTfvars).toContain('agent_db_engine_version           = "17"');
		expect(`${variables}\n${prodTfvars}\n${exampleTfvars}`).not.toContain('"17.9"');
	});

	it("shared infrastructure fallbacks are explicit and conditional", () => {
		const locals = readFileSync(join(terraformDir, "locals.tf"), "utf8");
		const sharedState = readFileSync(join(terraformDir, "shared_state.tf"), "utf8");
		const cloudwatch = readFileSync(join(terraformDir, "cloudwatch.tf"), "utf8");
		const albConfig = readFileSync(join(terraformDir, "alb.tf"), "utf8");
		const networkConfig = readFileSync(join(terraformDir, "network.tf"), "utf8");
		const outputs = readFileSync(join(terraformDir, "outputs.tf"), "utf8");

		expect(locals).toContain("shared_vpc_id_output = try(local.shared_service_outputs.vpc_id, null)");
		expect(locals).toContain(
			"shared_vpc_id        = coalesce(local.shared_vpc_id_output, one(data.aws_subnet.shared_ecs_first[*].vpc_id))",
		);
		expect(sharedState).toContain('data "aws_subnet" "shared_ecs_first"');
		expect(sharedState).toContain("count = local.shared_vpc_id_output == null ? 1 : 0");
		expect(sharedState).toContain('data "aws_ecs_cluster" "shared"');
		expect(sharedState).not.toContain('data "aws_ecs_service" "mymemo_service_api"');
		expect(sharedState).toContain("count = local.shared_ecs_cluster_arn_output == null");
		expect(sharedState).not.toContain('data "aws_lb" "shared"');
		expect(sharedState).not.toContain('data "aws_lb_listener" "shared_https"');
		expect(locals).not.toContain("shared_alb");
		expect(locals).toContain("trusted_caller_security_group_ids = var.mymemo_service_api_security_group_ids");
		expect(albConfig).toContain('resource "aws_lb" "agent"');
		expect(albConfig).toContain("internal           = true");
		expect(albConfig).toContain('resource "aws_lb_listener" "http"');
		expect(albConfig).not.toContain('resource "aws_lb_listener" "http_redirect"');
		expect(albConfig).not.toContain('resource "aws_lb_listener" "https"');
		expect(albConfig).not.toContain("certificate_arn");
		expect(networkConfig).toContain('resource "aws_security_group" "alb"');
		expect(networkConfig).toContain("security_groups = local.trusted_caller_security_group_ids");
		expect(networkConfig).not.toContain('description = "HTTP from the public internet"');
		expect(networkConfig).not.toContain('description = "HTTPS from the public internet"');
		expect(networkConfig).not.toContain('from_port       = 443');
		expect(networkConfig).toContain("source_security_group_id = aws_security_group.alb.id");
		expect(outputs).toContain('output "agent_internal_alb_dns_name"');
		expect(outputs).toContain('output "agent_internal_base_url"');
		expect(outputs).toContain('output "agent_internal_allowed_caller_security_group_ids"');
		expect(cloudwatch).toContain("LoadBalancer = aws_lb.agent.arn_suffix");
		expect(cloudwatch).toContain("ClusterName = local.shared_ecs_cluster_name");
		expect(cloudwatch).not.toContain("outputs.ecs_cluster_name");
	});

	it("migration task uses Terraform network settings", () => {
		const migrationScript = readFileSync(
			join(root, "scripts", "deploy", "run_agent_migration.sh"),
			"utf8",
		);
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");
		const outputs = readFileSync(join(terraformDir, "outputs.tf"), "utf8");

		expect(ecsConfig).toContain('entryPoint = ["bun", "run"]');
		expect(ecsConfig).toContain('command    = ["db:migrate"]');
		expect(ecsConfig).not.toContain('command   = ["bun", "run", "db:migrate"]');
		expect(outputs).toContain('output "assign_public_ip"');
		expect(migrationScript).toContain("terraform -chdir=infra/terraform output -raw assign_public_ip");
		expect(migrationScript).not.toContain("ASSIGN_PUBLIC_IP");
	});

	it("ecs desired counts remain Terraform-managed", () => {
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");

		expect(ecsConfig).toContain("desired_count   = var.chat_api_desired_count");
		expect(ecsConfig).toContain("desired_count   = var.agent_worker_desired_count");
		expect(ecsConfig).not.toContain("ignore_changes = [desired_count]");
	});

	it("deploy scripts share config loading", () => {
		const loader = readFileSync(
			join(root, "scripts", "deploy", "lib", "load_config.sh"),
			"utf8",
		);

		expect(loader).toContain("load_deploy_config()");
		expect(loader).toContain("DEPLOY_CONFIG_PATH=");
		expect(loader).toContain('if [[ "${!key+x}" != x ]]');
		expect(loader).toContain('export "$key"');
		expect(loader).not.toContain("source \"$DEPLOY_CONFIG_PATH\"");
		for (const script of [
			"build_and_push_agent_image.sh",
			"create_agent_secrets.sh",
			"detect_first_agent_deploy.sh",
			"prod_smoke.sh",
			"roll_ecs_services.sh",
			"run_agent_migration.sh",
		]) {
			const content = readFileSync(join(root, "scripts", "deploy", script), "utf8");
			if (script !== "detect_first_agent_deploy.sh") {
				expect(content).toContain('source "$script_dir/lib/load_config.sh"');
				expect(content).toContain("load_deploy_config");
			}
			expect(content).not.toContain('config="${DEPLOY_CONFIG:-infra/deploy/prod.env}"');
		}
		expect(createAgentSecretsScript).toContain("AWS_REGION is required in $DEPLOY_CONFIG_PATH or env");
	});

	it("terraform roots require a version that supports S3 lockfiles", () => {
		for (const dir of [terraformDir, ecrTerraformDir, bootstrapIamTerraformDir]) {
			const versions = readFileSync(join(dir, "versions.tf"), "utf8");

			expect(versions).toContain('required_version = ">= 1.10.0"');
			expect(versions).toContain("use_lockfile = true");
		}
	});

	it("image build script only documents supported ECR repositories", () => {
		const buildScript = readFileSync(
			join(root, "scripts", "deploy", "build_and_push_agent_image.sh"),
			"utf8",
		);

		expect(buildScript).toContain('output_name="chat_api_ecr_repository_url"');
		expect(buildScript).toContain('output_name="agent_worker_ecr_repository_url"');
		expect(buildScript).toContain('terraform -chdir=infra/ecr output -raw "$output_name"');
		expect(buildScript).not.toContain('repository="mymemo-agent-chat-api"');
		expect(buildScript).not.toContain('repository="mymemo-agent-worker"');
		expect(buildScript).not.toContain("AWS_ACCOUNT_ID");
		expect(buildScript).not.toContain("ECR_REPOSITORY_PREFIX");
	});

	it("ships the Live text workspace package in both runtime images", () => {
		for (const dockerfile of [
			join(root, "apps", "chat-api", "Dockerfile"),
			join(root, "apps", "agent-worker", "Dockerfile"),
		]) {
			const releaseStage = readFileSync(dockerfile, "utf8").split(
				"FROM base AS release",
			)[1];

			expect(releaseStage).toMatch(/^COPY .*packages\/live-text/m);
		}
	});

	it("exec-verifies the SDK CLI in every built worker image before push", () => {
		const checkPath = join(
			root,
			"scripts",
			"smoke",
			"agent-worker-image-check.sh",
		);
		expect(existsSync(checkPath)).toBe(true);
		const checkScript = readFileSync(checkPath, "utf8");
		const buildScript = readFileSync(
			join(root, "scripts", "deploy", "build_and_push_agent_image.sh"),
			"utf8",
		);
		const ciWorkflow = readFileSync(
			join(root, ".github", "workflows", "ci.yml"),
			"utf8",
		);

		expect(checkScript).toContain("docker run --rm");
		expect(checkScript).toContain("--network none");
		expect(checkScript).toContain("--entrypoint bun");
		expect(checkScript).toContain("resolveAndVerifyClaudeCodeExecutable");
		expect(ciWorkflow).toContain("agent-worker-image-check.sh");

		const buildIndex = buildScript.indexOf("docker build");
		const checkIndex = buildScript.indexOf("agent-worker-image-check.sh");
		const pushIndex = buildScript.indexOf("docker push");
		expect(buildIndex).toBeGreaterThan(-1);
		expect(checkIndex).toBeGreaterThan(buildIndex);
		expect(checkIndex).toBeLessThan(pushIndex);
	});

	it("secret bootstrap parses ignored values without sourcing them", () => {
		expect(createAgentSecretsScript).toContain("load_dotenv_file");
		expect(createAgentSecretsScript).not.toContain('source "$secrets_config"');
		expect(createAgentSecretsScript).not.toContain("secret-arns.env");
	});

	it("terraform resolves application secret ARNs from stable secret names", () => {
		const combined = terraformFiles()
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(combined).toContain('data "aws_secretsmanager_secret" "statsig_server"');
		expect(combined).toContain("statsig_server_secret_name");
		expect(combined).toContain("data.aws_secretsmanager_secret.statsig_server.arn");
		expect(combined).not.toContain('data "aws_secretsmanager_secret" "llm_token"');
		expect(combined).not.toContain("llm_token_secret_name");
		expect(combined).not.toContain('variable "llm_token_secret_arn"');
		expect(combined).not.toContain("var.llm_token_secret_arn");
		expect(combined).not.toContain('variable "extra_secret_arns"');
		expect(combined).not.toContain('variable "extra_task_policy_json"');
		expect(combined).not.toContain('resource "aws_iam_role_policy" "extra_task_policy"');
	});

	it("deployment env examples satisfy current app env loaders", () => {
		const common = {
			AGENT_DATABASE_URL:
				"postgresql://agent:agent@db.example.com:5432/mymemo_agent",
			ARTIFACT_BUCKET: "mymemo-agent-prod-artifacts",
			AWS_REGION: "us-west-2",
			DB_SSL: "require",
			DB_PASSWORD: undefined,
			LOG_LEVEL: "info",
			E2B_API_KEY: "e2b_test_key",
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
	});
});
