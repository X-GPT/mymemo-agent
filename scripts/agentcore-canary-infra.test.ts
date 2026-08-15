import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const terraformDir = join(root, "infra", "agentcore-canary");

function terraformFiles(): string[] {
	if (!existsSync(terraformDir)) return [];
	return readdirSync(terraformDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".tf"))
		.map((entry) => join(terraformDir, entry.name));
}

function terraformSource(): string {
	return terraformFiles()
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
}

describe("dormant AgentCore canary infrastructure", () => {
	it("uses an isolated locked state and independently pinned native AWS provider", () => {
		const versionsPath = join(terraformDir, "versions.tf");
		expect(existsSync(versionsPath)).toBe(true);
		const versions = readFileSync(versionsPath, "utf8");

		expect(versions).toContain(
			'key          = "mymemo-agent/agentcore-canary-prod.tfstate"',
		);
		expect(versions).toContain("use_lockfile = true");
		expect(versions).toContain("encrypt      = true");
		expect(versions).toMatch(/version\s*=\s*">= 6\.50, < 7\.0"/);
		expect(versions).not.toContain("hashicorp/awscc");
		expect(existsSync(join(terraformDir, ".terraform.lock.hcl"))).toBe(true);
	});

	it("owns no shared Fargate, database, cache, bucket, or user-routing resources", () => {
		const source = terraformSource();

		for (const forbiddenType of [
			"aws_ecs_cluster",
			"aws_ecs_service",
			"aws_ecs_task_definition",
			"aws_db_instance",
			"aws_elasticache_replication_group",
			"aws_s3_bucket",
			"aws_lb",
			"aws_lb_listener",
			"aws_route53_record",
		]) {
			expect(source).not.toMatch(new RegExp(`resource\\s+"${forbiddenType}"`));
		}
		expect(source).toContain('data "terraform_remote_state" "mymemo_agent"');
		expect(source).toContain('data "terraform_remote_state" "mymemo_service"');
	});

	it("pins the encrypted standard queue, DLQ, consumer, and repair schedule contract", () => {
		const source = terraformSource();

		expect(source).toMatch(
			/resource\s+"aws_sqs_queue"\s+"dispatch"[\s\S]*?message_retention_seconds\s*=\s*86400[\s\S]*?visibility_timeout_seconds\s*=\s*300[\s\S]*?kms_master_key_id\s*=\s*aws_kms_key\.canary\.arn/,
		);
		expect(source).toMatch(
			/resource\s+"aws_sqs_queue"\s+"dead_letter"[\s\S]*?message_retention_seconds\s*=\s*86400[\s\S]*?kms_master_key_id\s*=\s*aws_kms_key\.canary\.arn/,
		);
		expect(source).toMatch(/maxReceiveCount\s*=\s*3/);
		expect(source).toMatch(
			/resource\s+"aws_lambda_function"\s+"consumer"[\s\S]*?timeout\s*=\s*120[\s\S]*?reserved_concurrent_executions\s*=\s*1/,
		);
		expect(source).toMatch(
			/resource\s+"aws_lambda_event_source_mapping"\s+"consumer"[\s\S]*?batch_size\s*=\s*1[\s\S]*?function_response_types\s*=\s*\["ReportBatchItemFailures"\][\s\S]*?enabled\s*=\s*var\.dispatch_enabled/,
		);
		expect(source).toMatch(
			/resource\s+"aws_cloudwatch_event_rule"\s+"repair"[\s\S]*?schedule_expression\s*=\s*"rate\(1 minute\)"[\s\S]*?state\s*=\s*var\.dispatch_enabled\s*\?\s*"ENABLED"\s*:\s*"DISABLED"/,
		);
		expect(source).toMatch(
			/variable\s+"dispatch_enabled"[\s\S]*?default\s*=\s*false/,
		);
	});

	it("deploys a digest-pinned native Runtime with secret-ARN-only configuration", () => {
		const source = terraformSource();

		expect(source).toContain(
			'resource "aws_bedrockagentcore_agent_runtime" "canary"',
		);
		expect(source).toMatch(
			/container_uri\s*=\s*"\$\{aws_ecr_repository\.runtime\.repository_url\}@\$\{var\.runtime_image_digest\}"/,
		);
		expect(source).toContain('image_tag_mutability = "IMMUTABLE"');
		expect(source).toMatch(/network_mode\s*=\s*"VPC"/);
		expect(source).toMatch(/server_protocol\s*=\s*"HTTP"/);
		expect(source).toMatch(/max_lifetime\s*=\s*3600/);
		for (const name of [
			"CANARY_AGENT_DATABASE_URL_SECRET_ARN",
			"CANARY_KB_DATABASE_URL_SECRET_ARN",
			"CANARY_OPENROUTER_API_KEY_SECRET_ARN",
			"CANARY_E2B_API_KEY_SECRET_ARN",
			"CANARY_REDIS_URL_SECRET_ARN",
		]) {
			expect(source).toContain(name);
		}
		for (const forbiddenSecret of [
			"AGENT_DATABASE_URL",
			"KB_DATABASE_URL",
			"OPENROUTER_API_KEY",
			"E2B_API_KEY",
			"REDIS_URL",
		]) {
			expect(source).not.toMatch(new RegExp(`\\n\\s*${forbiddenSecret}\\s*=`));
		}
		expect(source).toMatch(
			/RDS_CA_BUNDLE_PATH\s*=\s*"\/etc\/ssl\/certs\/rds-global-bundle\.pem"/,
		);
		expect(source).toMatch(
			/NODE_EXTRA_CA_CERTS\s*=\s*"\/etc\/ssl\/certs\/rds-global-bundle\.pem"/,
		);
	});

	it("keeps private networking while making NAT and EIP campaign-scoped", () => {
		const source = terraformSource();

		expect(source).toContain('resource "aws_subnet" "private"');
		expect(source).toContain("map_public_ip_on_launch = false");
		expect(source).toContain('resource "aws_security_group" "canary"');
		expect(source).toMatch(
			/resource\s+"aws_eip"\s+"campaign"[\s\S]*?count\s*=\s*var\.campaign_network_enabled\s*\?\s*1\s*:\s*0/,
		);
		expect(source).toMatch(
			/resource\s+"aws_nat_gateway"\s+"campaign"[\s\S]*?count\s*=\s*var\.campaign_network_enabled\s*\?\s*1\s*:\s*0/,
		);
		expect(source).toMatch(
			/variable\s+"campaign_network_enabled"[\s\S]*?default\s*=\s*false/,
		);
		expect(source).toContain('data "aws_security_group" "live_redis_clients"');
		expect(source).toContain("service_security_group_id");
		expect(source).toContain(
			"security_groups = local.runtime_security_group_ids",
		);
		expect(source).not.toMatch(/resource\s+"aws_security_group_rule"/);
	});

	it("separates least-privilege roles and protects GitHub authority with the production Environment", () => {
		const source = terraformSource();

		for (const role of [
			"deployment",
			"campaign_launch",
			"task",
			"publisher",
			"consumer",
			"runtime",
			"fault_injection",
		]) {
			expect(source).toContain(`resource "aws_iam_role" "${role}"`);
		}
		expect(source).toContain("environment:production-agentcore-canary");
		expect(source).toMatch(
			/"\$\{aws_bedrockagentcore_agent_runtime\.canary\.agent_runtime_arn\}\/runtime-endpoint\/DEFAULT"/,
		);
		expect(source).toContain("resources = local.exact_secret_arns");
		expect(source).not.toMatch(
			/resource\s+"aws_iam_role_policy"\s+"campaign_launch"[\s\S]*?(rds:|secretsmanager:GetSecretValue)/,
		);
	});

	it("creates low-cardinality paging and validation alarms", () => {
		const alarms = readFileSync(join(terraformDir, "alarms.tf"), "utf8");

		for (const metric of [
			"ApproximateAgeOfOldestMessage",
			"ApproximateNumberOfMessagesVisible",
			"Errors",
			"Throttles",
			"ActiveSessionCount",
			"PoisonDispatch",
			"CrossLaneExecution",
			"CleanupResidue",
			"CampaignDeadlineBreach",
			"NatExpiryBreach",
		]) {
			expect(alarms).toContain(`metric_name`);
			expect(alarms).toContain(metric);
		}
		for (const forbiddenDimension of [
			"CampaignId",
			"ConversationId",
			"RunId",
			"Prompt",
			"Model",
			"Tool",
			"DocumentId",
			"Artifact",
		]) {
			expect(alarms).not.toContain(forbiddenDimension);
		}
		expect(alarms).toMatch(
			/alarm_actions\s*=\s*var\.incident_alarm_action_arns/,
		);
		expect(alarms).toMatch(
			/alarm_actions\s*=\s*var\.validation_alarm_action_arns/,
		);
	});

	it("ships a manual Environment-approved image promotion and dormant inspection", () => {
		const workflow = readFileSync(
			join(root, ".github", "workflows", "agentcore-canary-deploy.yml"),
			"utf8",
		);
		const inspection = readFileSync(
			join(root, "scripts", "deploy", "inspect_agentcore_canary_dormant.sh"),
			"utf8",
		);

		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).not.toMatch(/\n\s+(push|workflow_run):/);
		expect(workflow).toContain("environment: production-agentcore-canary");
		expect(workflow).toContain("deploy-mymemo-agentcore-canary-prod");
		expect(workflow).toContain("platforms: linux/arm64");
		expect(workflow).toContain("docker pull --platform linux/arm64");
		expect(workflow).toContain(
			"agentcore-canary-runtime-image-check.sh agentcore-canary-existing:verified",
		);
		expect(workflow).toContain("runtime_image_digest");
		expect(workflow).toContain("classify_agentcore_canary_plan.sh");
		expect(workflow).toContain("requireMMDSV2");
		expect(workflow).toContain("inspect_agentcore_canary_dormant.sh");
		expect(workflow).toContain("agent_runtime_version");

		for (const requiredCheck of [
			"get-queue-attributes",
			"get-event-source-mapping",
			"describe-rule",
			"get-parameter",
			"get-agent-runtime",
			"get-agent-runtime-endpoint",
			"metadataConfiguration.requireMMDSV2",
			"ActiveSessionCount",
			"campaign_nat_gateway_ids",
			"campaign_eip_allocation_ids",
			"describe-alarms",
			"list-secret-version-ids",
		]) {
			expect(inspection).toContain(requiredCheck);
		}
		expect(inspection).toContain("describe-nat-gateways");
		expect(inspection).toContain("describe-addresses");
		expect(inspection).not.toContain("invoke-function");
		expect(inspection).not.toContain("invoke-agent-runtime");
	});

	it("ships a non-Run verified-TLS preflight with rollback and cleanup checks", () => {
		const preflight = readFileSync(
			join(root, "scripts", "deploy", "preflight_agentcore_canary.sh"),
			"utf8",
		);

		expect(terraformSource()).toContain(
			'resource "aws_lambda_function" "preflight"',
		);
		expect(preflight).toContain("preflight_function_name");
		expect(preflight).toContain("lambda invoke");
		expect(preflight).toContain("runAdmitted == false");
		expect(preflight).toContain("describe-images");
		expect(preflight).toContain("StopRuntimeSession");
		expect(preflight).toContain("describe-alarms");
		expect(preflight).not.toContain("invoke-agent-runtime");
		expect(preflight).not.toContain("/runs");
	});
});
