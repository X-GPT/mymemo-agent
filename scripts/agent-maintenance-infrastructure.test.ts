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
	it("defines an independently healthy, logged, inactive service", () => {
		const ecs = terraformFile("ecs.tf");
		const cloudwatch = terraformFile("cloudwatch.tf");
		const production = terraformFile("prod.tfvars");

		expect(ecs).toContain(
			'resource "aws_ecs_task_definition" "agent_maintenance"',
		);
		expect(ecs).toContain('resource "aws_ecs_service" "agent_maintenance"');
		expect(ecs).toContain("aws_cloudwatch_log_group.agent_maintenance.name");
		expect(ecs).toContain("/health");
		expect(ecs).toContain(
			"var.agent_maintenance_desired_count == 0 || var.agent_worker_desired_count == 0",
		);
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_log_metric_filter" "agent_maintenance_errors"',
		);
		expect(cloudwatch).toContain(
			'resource "aws_cloudwatch_metric_alarm" "agent_maintenance_errors"',
		);
		expect(production).toContain("agent_maintenance_desired_count = 0");
	});

	it("injects only maintenance environment and secrets", () => {
		const locals = terraformFile("locals.tf");
		const maintenance = section(
			locals,
			"agent_maintenance_environment =",
			"agentcore_dispatch_publisher_environment =",
		);

		for (const required of [
			"E2B_API_KEY",
			"ARTIFACT_BUCKET",
			"AWS_REGION",
			"MAINTENANCE_CLEANUP_INTERVAL_MS",
		]) {
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
		expect(taskPolicy).not.toContain("s3:PutObject");
		expect(taskPolicy).not.toContain("s3:GetObject");
		expect(securityGroup).toContain("from_port       = 5432");
		expect(securityGroup).toContain("from_port   = 443");
		expect(securityGroup).toContain("VPC DNS over UDP");
		expect(securityGroup).toContain("VPC DNS over TCP");
		expect(securityGroup).not.toContain('protocol    = "-1"');
	});
});
