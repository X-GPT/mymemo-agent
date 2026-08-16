import { describe, expect, it } from "bun:test";
import {
	classifyAgentCoreCanaryPlan,
	verifyAgentCoreProviderLock,
} from "./classify_agentcore_canary_plan";

function plan(changes: unknown[]) {
	return { format_version: "1.2", resource_changes: changes };
}

function change(
	address: string,
	type: string,
	actions: string[],
	before: unknown = null,
	after: unknown = {},
) {
	return { address, mode: "managed", type, change: { actions, before, after } };
}

const lambdaTrust = JSON.stringify({
	Version: "2012-10-17",
	Statement: [
		{
			Effect: "Allow",
			Action: "sts:AssumeRole",
			Principal: { Service: "lambda.amazonaws.com" },
		},
	],
});

function runtimeTrust(sourceAccount: string, sourceArn: string) {
	return JSON.stringify({
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Allow",
				Action: "sts:AssumeRole",
				Principal: { Service: "bedrock-agentcore.amazonaws.com" },
				Condition: {
					ArnLike: { "aws:SourceArn": sourceArn },
					StringEquals: { "aws:SourceAccount": sourceAccount },
				},
			},
		],
	});
}

describe("AgentCore canary Terraform plan classification", () => {
	it("accepts additive and in-place changes only for canary-owned resources", () => {
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change(
						"aws_bedrockagentcore_agent_runtime.canary",
						"aws_bedrockagentcore_agent_runtime",
						["create"],
					),
					change("aws_lambda_function.consumer", "aws_lambda_function", [
						"update",
					]),
				]),
			),
		).toEqual({ safe: true, reasons: [] });
	});

	it("rejects deletion or replacement of retained resources", () => {
		for (const actions of [
			["delete"],
			["delete", "create"],
			["create", "delete"],
		]) {
			const result = classifyAgentCoreCanaryPlan(
				plan([
					change(
						"aws_lambda_function.consumer",
						"aws_lambda_function",
						actions,
					),
				]),
			);
			expect(result.safe).toBe(false);
			expect(result.reasons.join(" ")).toContain("deletion or replacement");
		}
	});

	it("allows deletion only for the exact retired control-plane resources", () => {
		for (const [address, type] of [
			["aws_lambda_function.control", "aws_lambda_function"],
			["aws_lambda_function.preflight", "aws_lambda_function"],
			["aws_iam_role.control", "aws_iam_role"],
			["aws_iam_role.preflight", "aws_iam_role"],
			["aws_iam_role_policy.control", "aws_iam_role_policy"],
			["aws_iam_role_policy.control_base", "aws_iam_role_policy"],
			["aws_iam_role_policy.preflight", "aws_iam_role_policy"],
			["aws_eip.campaign[0]", "aws_eip"],
			["aws_nat_gateway.campaign[0]", "aws_nat_gateway"],
			['aws_route.campaign_egress["private-a"]', "aws_route"],
			[
				"aws_cloudwatch_metric_alarm.dormant_runtime_sessions",
				"aws_cloudwatch_metric_alarm",
			],
			[
				'aws_cloudwatch_metric_alarm.lambda_errors["control"]',
				"aws_cloudwatch_metric_alarm",
			],
			[
				'aws_cloudwatch_metric_alarm.lambda_throttles["preflight"]',
				"aws_cloudwatch_metric_alarm",
			],
			[
				'aws_cloudwatch_metric_alarm.incident["CampaignDeadlineBreach"]',
				"aws_cloudwatch_metric_alarm",
			],
			[
				'aws_cloudwatch_metric_alarm.validation["Acquired"]',
				"aws_cloudwatch_metric_alarm",
			],
		] as const) {
			expect(
				classifyAgentCoreCanaryPlan(plan([change(address, type, ["delete"])])),
			).toEqual({ safe: true, reasons: [] });
		}

		for (const actions of [["create"], ["update"], ["delete", "create"]]) {
			const result = classifyAgentCoreCanaryPlan(
				plan([
					change("aws_lambda_function.control", "aws_lambda_function", actions),
				]),
			);
			expect(result.safe).toBe(false);
			expect(result.reasons.join(" ")).toContain("retired control-plane");
		}
	});

	it("rejects removal from state", () => {
		const result = classifyAgentCoreCanaryPlan(
			plan([
				change("aws_lambda_function.consumer", "aws_lambda_function", [
					"forget",
				]),
			]),
		);
		expect(result.reasons).toContain(
			"aws_lambda_function.consumer requests removal from Terraform state",
		);
	});

	it("rejects shared resources, modules, and campaign-only authority", () => {
		for (const [address, type] of [
			["aws_ecs_service.agent_worker", "aws_ecs_service"],
			["aws_db_instance.agent", "aws_db_instance"],
			["module.shared.aws_vpc.main", "aws_vpc"],
			["aws_iam_role.deployment", "aws_iam_role"],
			["aws_iam_role.task", "aws_iam_role"],
			["aws_iam_role.fault_injection", "aws_iam_role"],
			["aws_iam_role.campaign_launch", "aws_iam_role"],
		]) {
			const result = classifyAgentCoreCanaryPlan(
				plan([change(address, type, ["create"])]),
			);
			expect(result.reasons).toContain(
				`${address} is outside canary ownership (${type})`,
			);
		}
	});

	it("rejects every workload trust mutation", () => {
		const result = classifyAgentCoreCanaryPlan(
			plan([
				change(
					"aws_iam_role.runtime",
					"aws_iam_role",
					["update"],
					{ assume_role_policy: "old" },
					{ assume_role_policy: "expanded" },
				),
			]),
		);
		expect(result.reasons).toContain(
			"aws_iam_role.runtime requests IAM trust mutation",
		);
	});

	it("accepts only the exact Lambda and Runtime creation trusts", () => {
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change("aws_iam_role.publisher", "aws_iam_role", ["create"], null, {
						assume_role_policy: lambdaTrust,
					}),
				]),
			),
		).toEqual({ safe: true, reasons: [] });

		const exactRuntimeArn =
			"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/mymemo_agentcore_canary_prod-*";
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change("aws_iam_role.runtime", "aws_iam_role", ["create"], null, {
						assume_role_policy: runtimeTrust("637423444544", exactRuntimeArn),
					}),
				]),
			),
		).toEqual({ safe: true, reasons: [] });

		for (const [address, trust] of [
			[
				"aws_iam_role.publisher",
				JSON.stringify({
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Action: "sts:AssumeRole",
							Principal: { AWS: "*" },
						},
					],
				}),
			],
			["aws_iam_role.runtime", runtimeTrust("111111111111", exactRuntimeArn)],
			[
				"aws_iam_role.runtime",
				runtimeTrust(
					"637423444544",
					"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/*",
				),
			],
		] as const) {
			const result = classifyAgentCoreCanaryPlan(
				plan([
					change(address, "aws_iam_role", ["create"], null, {
						assume_role_policy: trust,
					}),
				]),
			);
			expect(result.reasons).toContain(
				`${address} has unapproved IAM trust on creation`,
			);
		}
	});

	it("requires an independently locked AWS 6.x provider satisfying >= 6.50", () => {
		expect(
			verifyAgentCoreProviderLock(`
provider "registry.terraform.io/hashicorp/random" {
  version = "3.7.2"
}
provider "registry.terraform.io/hashicorp/aws" {
  version     = "6.60.0"
  constraints = ">= 6.50.0, < 7.0.0"
}`),
		).toEqual({ safe: true, reasons: [] });
		for (const lock of [
			'provider "registry.terraform.io/hashicorp/aws" {\n  version = "5.100.0"\n  constraints = "~> 5.0"\n}',
			'provider "registry.terraform.io/hashicorp/aws" {\n  version = "7.0.0"\n  constraints = ">= 6.50.0"\n}',
			'provider "registry.terraform.io/hashicorp/aws" {\n  version = "6.60.0"\n  constraints = ">= 6.50.0"\n}',
		]) {
			expect(verifyAgentCoreProviderLock(lock).safe).toBe(false);
		}
	});
});
