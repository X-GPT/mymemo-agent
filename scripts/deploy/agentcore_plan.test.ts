import { describe, expect, it } from "bun:test";
import {
	classifyAgentCorePlan,
	verifyAgentCoreProviderLock,
} from "./classify_agentcore_plan";

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
	return {
		address,
		mode: "managed",
		type,
		change: { actions, before, after },
	};
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

describe("production AgentCore Terraform plan classification", () => {
	it("accepts additive and in-place changes only for production-owned resources", () => {
		expect(
			classifyAgentCorePlan(
				plan([
					change(
						"aws_bedrockagentcore_agent_runtime.runtime",
						"aws_bedrockagentcore_agent_runtime",
						["create"],
					),
					change("aws_lambda_function.consumer", "aws_lambda_function", [
						"update",
					]),
					change('aws_eip.egress["us-west-2a"]', "aws_eip", ["create"]),
					change('aws_nat_gateway.egress["us-west-2a"]', "aws_nat_gateway", [
						"create",
					]),
					change('aws_route.private_egress["us-west-2a"]', "aws_route", [
						"create",
					]),
				]),
			),
		).toEqual({ safe: true, reasons: [] });
	});

	it("rejects every steady-state deletion or replacement", () => {
		for (const [address, type] of [
			[
				"aws_bedrockagentcore_agent_runtime.runtime",
				"aws_bedrockagentcore_agent_runtime",
			],
			["aws_lambda_function.consumer", "aws_lambda_function"],
			["aws_sqs_queue.dispatch", "aws_sqs_queue"],
		] as const) {
			const result = classifyAgentCorePlan(
				plan([change(address, type, ["delete", "create"])]),
			);
			expect(result.safe).toBe(false);
			expect(result.reasons).toContain(
				`${address} requests deletion or replacement`,
			);
		}
	});

	it("rejects removal from state and resources outside the shared stack", () => {
		const forgotten = classifyAgentCorePlan(
			plan([
				change("aws_lambda_function.consumer", "aws_lambda_function", [
					"forget",
				]),
			]),
		);
		expect(forgotten.reasons).toContain(
			"aws_lambda_function.consumer requests removal from Terraform state",
		);

		for (const [address, type] of [
			["aws_ecs_service.agent_worker", "aws_ecs_service"],
			["aws_ecs_service.agentcore_dispatch_publisher", "aws_ecs_service"],
			["aws_db_instance.agent", "aws_db_instance"],
			["module.shared.aws_vpc.main", "aws_vpc"],
		]) {
			const result = classifyAgentCorePlan(
				plan([change(address, type, ["create"])]),
			);
			expect(result.reasons).toContain(
				`${address} is outside production AgentCore ownership (${type})`,
			);
		}
	});

	it("rejects workload trust mutation", () => {
		const result = classifyAgentCorePlan(
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

	it("accepts only the exact consumer and production Runtime creation trusts", () => {
		expect(
			classifyAgentCorePlan(
				plan([
					change("aws_iam_role.consumer", "aws_iam_role", ["create"], null, {
						assume_role_policy: lambdaTrust,
					}),
				]),
			),
		).toEqual({ safe: true, reasons: [] });

		const exactRuntimeArn =
			"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/mymemo_agentcore_prod-*";
		expect(
			classifyAgentCorePlan(
				plan([
					change("aws_iam_role.runtime", "aws_iam_role", ["create"], null, {
						assume_role_policy: runtimeTrust("637423444544", exactRuntimeArn),
					}),
				]),
			),
		).toEqual({ safe: true, reasons: [] });

		for (const [address, trust] of [
			[
				"aws_iam_role.consumer",
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
			const result = classifyAgentCorePlan(
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
