import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

function expectAll(source: string, fragments: string[]): void {
	for (const fragment of fragments) expect(source).toContain(fragment);
}

describe("chat-api Service Connect infrastructure", () => {
	it("adds Service Connect without replacing the trusted ALB path", () => {
		const ecs = read("infra/terraform/ecs.tf");
		const alb = read("infra/terraform/alb.tf");
		const network = read("infra/terraform/network.tf");
		const outputs = read("infra/terraform/outputs.tf");
		const workflow = read(".github/workflows/release-deploy.yml");

		expectAll(read("infra/terraform/service-connect.tf"), [
			'resource "aws_service_discovery_http_namespace" "services"',
		]);
		expectAll(ecs, [
			"name          = local.chat_api_service_connect_port_name",
			'appProtocol   = "http"',
			"namespace = aws_service_discovery_http_namespace.services.arn",
			"ingress_port_override = local.chat_api_service_connect_ingress_port",
			"idle_timeout_seconds        = 0",
			"per_request_timeout_seconds = 0",
			"target_group_arn = aws_lb_target_group.chat_api.arn",
		]);
		expectAll(alb, [
			'resource "aws_lb" "agent"',
			'resource "aws_lb_target_group" "chat_api"',
			'resource "aws_lb_listener" "http"',
		]);
		expectAll(network, [
			'resource "aws_security_group_rule" "chat_api_from_alb"',
			"source_security_group_id = aws_security_group.alb.id",
			"from_port                = var.chat_api_port",
			'resource "aws_security_group_rule" "chat_api_service_connect_from_trusted_callers"',
			"for_each = toset(local.trusted_caller_security_group_ids)",
			"source_security_group_id = each.value",
			"from_port                = local.chat_api_service_connect_ingress_port",
		]);
		expectAll(outputs, [
			'output "chat_api_service_connect_namespace_arn"',
			'output "chat_api_service_connect_endpoint"',
			'output "chat_api_target_group_arn"',
			'output "agent_internal_base_url"',
		]);
		expectAll(read("infra/terraform/cloudwatch.tf"), [
			'resource "aws_cloudwatch_metric_alarm" "chat_api_unhealthy"',
			"TargetGroup  = aws_lb_target_group.chat_api.arn_suffix",
		]);
		expect(read("infra/bootstrap-iam/main.tf")).toContain(
			'"servicediscovery:*"',
		);
		expectAll(read("scripts/deploy/terraform_prod_migration_plan.sh"), [
			"-target=aws_ecs_task_definition.chat_api",
		]);
		expectAll(read("scripts/deploy/prepare_chat_api_service_connect.sh"), [
			"task_definition_has_service_connect_port",
			"aws ecs update-service",
			"aws ecs wait services-stable",
		]);

		const prerequisite = workflow.indexOf(
			"Roll the Service Connect named-port prerequisite",
		);
		expect(prerequisite).toBeGreaterThanOrEqual(0);
		expect(workflow.indexOf("Apply the unified release")).toBeGreaterThan(
			prerequisite,
		);
	});
});
