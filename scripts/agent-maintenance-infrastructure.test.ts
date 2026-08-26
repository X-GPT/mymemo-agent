import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function terraformFile(name: string): string {
	return readFileSync(`infra/terraform/${name}`, "utf8");
}

function section(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

describe("agent-maintenance infrastructure", () => {
	it("defines the independently healthy, logged sole maintenance owner", () => {
		const ecs = terraformFile("ecs.tf");
		const cloudwatch = terraformFile("cloudwatch.tf");
		const desiredCount = section(
			terraformFile("variables.tf"),
			'variable "agent_maintenance_desired_count"',
			'variable "agentcore_dispatch_publisher_desired_count"',
		);
		const deployment = readFileSync(
			"scripts/deploy/terraform_prod_in_place_plan.sh",
			"utf8",
		);

		expect(ecs).toContain(
			'resource "aws_ecs_task_definition" "agent_maintenance"',
		);
		expect(ecs).toContain('resource "aws_ecs_service" "agent_maintenance"');
		expect(ecs).toContain(
			"desired_count   = var.agent_maintenance_desired_count",
		);
		expect(ecs).toContain("aws_cloudwatch_log_group.agent_maintenance.name");
		expect(ecs).toContain("/health");
		expect(ecs).not.toContain("agent_worker");
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_log_metric_filter" "agent_maintenance_errors"',
		);
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_metric_alarm" "agent_maintenance_errors"',
		);
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_log_metric_filter" "agent_maintenance_heartbeat"',
		);
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_metric_alarm" "agent_maintenance_heartbeat"',
		);
		expect(cloudwatch).toContain("count = var.agent_maintenance_desired_count");
		expect(cloudwatch).toContain('treat_missing_data  = "breaching"');
		expect(desiredCount).toContain("default     = 1");
		expect(desiredCount).toContain(
			"var.agent_maintenance_desired_count == 0 || var.agent_maintenance_desired_count == 1",
		);
		expect(deployment).toContain('-var="agent_maintenance_desired_count=0"');
	});

	it("contains no retired worker execution infrastructure", () => {
		for (const name of [
			"cloudwatch.tf",
			"ecs.tf",
			"iam.tf",
			"locals.tf",
			"network.tf",
			"outputs.tf",
			"variables.tf",
		]) {
			const source = terraformFile(name);
			expect(source).not.toContain("agent_worker");
			expect(source).not.toContain("agent-worker");
		}
		expect(terraformFile("variables.tf")).not.toContain(
			"worker_heartbeat_interval_ms",
		);
	});

	it("scopes chat-api and migration secrets independently", () => {
		const locals = terraformFile("locals.tf");
		const iam = terraformFile("iam.tf");
		const ecs = terraformFile("ecs.tf");
		const chatApi = section(
			locals,
			"chat_api_environment =",
			"agent_maintenance_environment =",
		);
		const chatApiSecretPolicy = section(
			iam,
			'data "aws_iam_policy_document" "read_secrets"',
			'resource "aws_iam_role" "agent_migration_execution"',
		);
		const migrationSecretPolicy = section(
			iam,
			'resource "aws_iam_role" "agent_migration_execution"',
			'resource "aws_iam_role" "agentcore_dispatch_publisher_execution"',
		);
		const migrationTask = section(
			ecs,
			'resource "aws_ecs_task_definition" "agent_migration"',
			'resource "aws_ecs_service" "chat_api"',
		);

		for (const forbidden of ["E2B", "OPENROUTER", "KB_DATABASE_URL"]) {
			expect(chatApi).not.toContain(forbidden);
			expect(chatApiSecretPolicy).not.toContain(forbidden);
			expect(migrationSecretPolicy).not.toContain(forbidden);
		}
		for (const required of [
			"agent_db_password_base_secret_arn",
			"statsig_server_secret_arn",
			"live_redis_url_secret_arn",
		]) {
			expect(chatApiSecretPolicy).toContain(required);
		}
		expect(migrationSecretPolicy).toContain(
			"agent_db_password_base_secret_arn",
		);
		expect(migrationSecretPolicy).not.toContain("statsig_server_secret_arn");
		expect(migrationSecretPolicy).not.toContain("live_redis_url_secret_arn");
		expect(migrationTask).toContain(
			"execution_role_arn       = aws_iam_role.agent_migration_execution.arn",
		);
		expect(migrationTask).toContain(
			"aws_iam_role_policy_attachment.agent_migration_execution",
		);
		expect(migrationTask).toContain(
			"aws_iam_role_policy.agent_migration_read_database_secret",
		);
		expect(migrationTask).not.toContain("task_role_arn");
	});

	it("collects Live Stream metrics from AgentCore Runtime logs", () => {
		const cloudwatch = terraformFile("cloudwatch.tf");

		expect(cloudwatch).toContain(
			`agentcore-runtime = "/aws/bedrock-agentcore/runtimes/\${aws_bedrockagentcore_agent_runtime.runtime.agent_runtime_id}-DEFAULT"`,
		);
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_log_metric_filter" "live_stream_capacity"',
		);
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_log_metric_filter" "live_stream_degraded_duration"',
		);
		expect(cloudwatch).toContain('Service = "agentcore-runtime"');
	});

	it("does not replace the fixed-name Live Stream client security group", () => {
		const redis = section(
			terraformFile("redis.tf"),
			'resource "aws_security_group" "live_redis_clients"',
			'resource "aws_security_group_rule" "live_redis_from_services"',
		);

		expect(redis).toContain("ignore_changes = [description]");
	});

	it("keeps the Valkey Live Stream relay ephemeral and endpoint-compatible", () => {
		const redis = terraformFile("redis.tf");
		const nodeType = section(
			terraformFile("variables.tf"),
			'variable "live_redis_node_type"',
			'variable "live_redis_engine_version"',
		);
		const engineVersion = section(
			terraformFile("variables.tf"),
			'variable "live_redis_engine_version"',
			'variable "alarm_action_arns"',
		);

		expect(redis).toContain('engine         = "valkey"');
		expect(engineVersion).toContain('default     = "7.2"');
		expect(nodeType).toContain('default     = "cache.t4g.micro"');
		expect(redis).toContain("node_type      = var.live_redis_node_type");
		expect(redis).toContain("num_cache_clusters         = 1");
		expect(redis).toContain("automatic_failover_enabled = false");
		expect(redis).toContain("multi_az_enabled           = false");
		expect(redis).toContain("transit_encryption_enabled = true");
		expect(redis).toContain('transit_encryption_mode    = "required"');
		expect(redis).toContain(
			"auth_token                 = random_password.live_redis.result",
		);
		expect(redis).toContain("snapshot_retention_limit = 0");
		expect(redis).toContain(
			"aws_elasticache_replication_group.live.primary_endpoint_address",
		);
		expect(redis).toContain('secret_string = "rediss://default:');
	});

	it("keeps retired repository deletion in the one-time handoff", () => {
		const ecr = readFileSync("infra/ecr/main.tf", "utf8");
		const release = readFileSync(
			".github/workflows/release-deploy.yml",
			"utf8",
		);
		const handoff = readFileSync(
			"docs/runbooks/agent-maintenance-handoff.md",
			"utf8",
		);

		expect(ecr).not.toContain("agent_worker");
		expect(release).not.toContain("aws ecr delete-repository");
		expect(handoff).toContain("aws --profile mymemo ecr delete-repository");
		expect(handoff).toContain("--repository-name mymemo-agent-worker");
		expect(handoff).toContain("--force");
	});

	it("waits for every retired worker task to reach STOPPED", () => {
		const handoff = readFileSync(
			"docs/runbooks/agent-maintenance-handoff.md",
			"utf8",
		);

		expect(handoff).toContain("--desired-status STOPPED");
		expect(handoff).toContain("lastStatus!=`STOPPED`");
		expect(handoff).toContain("DEACTIVATING");
		expect(handoff).toContain("DEPROVISIONING");
	});

	it("injects only maintenance environment and secrets", () => {
		const locals = terraformFile("locals.tf");
		const maintenance = section(
			locals,
			"agent_maintenance_environment =",
			"agentcore_dispatch_publisher_environment =",
		);

		for (const required of ["E2B_API_KEY", "ARTIFACT_BUCKET", "AWS_REGION"]) {
			expect(maintenance).toContain(required);
		}
		expect(maintenance).toContain("local.agent_database_url_environment");
		expect(maintenance).toContain("local.agent_db_password_secret");
		for (const forbidden of [
			"KB_DATABASE_URL",
			"OPENROUTER",
			"REDIS_URL",
			"AGENTCORE_DISPATCH",
			"WORKER_E2B_TEMPLATE",
		]) {
			expect(maintenance).not.toContain(forbidden);
		}
	});

	it("limits IAM and network authority to maintenance operations", () => {
		const iam = terraformFile("iam.tf");
		const agentCoreIam = terraformFile("agentcore-iam.tf");
		const network = terraformFile("network.tf");
		const executionPolicy = section(
			iam,
			'data "aws_iam_policy_document" "agent_maintenance_read_secrets"',
			'resource "aws_iam_role" "chat_api_task"',
		);
		const taskPolicy = section(
			iam,
			'data "aws_iam_policy_document" "agent_maintenance_artifact_delete"',
			'resource "aws_iam_role" "agentcore_dispatch_publisher_task"',
		);
		const chatApiArtifactPolicy = section(
			iam,
			'data "aws_iam_policy_document" "chat_api_artifact_read"',
			'resource "aws_iam_role_policy" "chat_api_artifact_read"',
		);
		const runtimePolicy = section(
			agentCoreIam,
			'data "aws_iam_policy_document" "runtime"',
			'resource "aws_iam_role_policy" "runtime"',
		);
		const queryRuntimePolicy = section(
			agentCoreIam,
			'data "aws_iam_policy_document" "query_runtime"',
			'resource "aws_iam_role_policy" "query_runtime"',
		);
		const queryRuntimeEnvironment = section(
			terraformFile("agentcore-locals.tf"),
			"query_runtime_environment = {",
			"lambda_common_environment = {",
		);
		const securityGroup = section(
			network,
			'resource "aws_security_group" "agent_maintenance"',
			'resource "aws_security_group_rule" "chat_api_from_alb"',
		);

		expect(executionPolicy).toContain(
			"local.agent_db_password_base_secret_arn",
		);
		expect(executionPolicy).toContain("local.e2b_api_key_secret_arn");
		expect(executionPolicy).not.toContain("kb_database_url_secret_arn");
		expect(executionPolicy).not.toContain("openrouter_api_key_secret_arn");
		expect(executionPolicy).not.toContain("live_redis_url_secret_arn");
		expect(taskPolicy).toContain('actions   = ["s3:DeleteObject"]');
		expect(taskPolicy).toContain("/objects/*");
		expect(taskPolicy).not.toContain("s3:PutObject");
		expect(taskPolicy).not.toContain("s3:GetObject");
		expect(chatApiArtifactPolicy).toContain("/objects/*");
		expect(runtimePolicy).toContain("s3:PutObject");
		expect(runtimePolicy).toContain("s3:AbortMultipartUpload");
		expect(runtimePolicy).not.toContain("s3:DeleteObject");
		expect(queryRuntimeEnvironment).toContain("ARTIFACT_BUCKET");
		expect(queryRuntimeEnvironment).toContain("aws_s3_bucket.artifacts.bucket");
		expect(queryRuntimePolicy).toContain('"s3:GetObject"');
		expect(queryRuntimePolicy).toContain('"s3:PutObject"');
		expect(queryRuntimePolicy).toContain("/agent-sessions/*");
		expect(queryRuntimePolicy).not.toContain("/objects/*");
		expect(queryRuntimePolicy).not.toContain("s3:ListBucket");
		expect(queryRuntimePolicy).not.toContain("s3:DeleteObject");
		expect(queryRuntimePolicy).not.toContain("s3:AbortMultipartUpload");
		expect(securityGroup).toContain("from_port       = 5432");
		expect(securityGroup).toContain("from_port   = 443");
		expect(securityGroup).toContain("VPC DNS over UDP");
		expect(securityGroup).toContain("VPC DNS over TCP");
		expect(securityGroup).not.toContain('protocol    = "-1"');
	});
});
