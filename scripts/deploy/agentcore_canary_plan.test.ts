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

describe("AgentCore canary Terraform plan classification", () => {
	it("accepts additive and in-place changes only for canary-owned resource types", () => {
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

	it("rejects every deletion or replacement", () => {
		for (const actions of [
			["delete"],
			["delete", "create"],
			["create", "delete"],
		]) {
			const result = classifyAgentCoreCanaryPlan(
				plan([
					change("aws_nat_gateway.campaign[0]", "aws_nat_gateway", actions),
				]),
			);
			expect(result.safe).toBe(false);
			expect(result.reasons.join(" ")).toContain("deletion or replacement");
		}
	});

	it("rejects removed-block plans that forget canary resources", () => {
		const result = classifyAgentCoreCanaryPlan(
			plan([
				change("aws_lambda_function.consumer", "aws_lambda_function", [
					"forget",
				]),
			]),
		);

		expect(result.safe).toBe(false);
		expect(result.reasons).toContain(
			"aws_lambda_function.consumer requests removal from Terraform state",
		);
	});

	it("rejects shared-resource mutation and ordinary-stack decommission", () => {
		for (const [address, type] of [
			["aws_ecs_service.agent_worker", "aws_ecs_service"],
			["aws_db_instance.agent", "aws_db_instance"],
			["aws_lambda_function.chat_api", "aws_lambda_function"],
			["module.shared.aws_vpc.main", "aws_vpc"],
		]) {
			const result = classifyAgentCoreCanaryPlan(
				plan([change(address, type, ["update"])]),
			);
			expect(result.safe).toBe(false);
			expect(result.reasons.join(" ")).toContain("outside canary ownership");
		}
	});

	it("rejects IAM trust mutation even when the role is canary-owned", () => {
		const result = classifyAgentCoreCanaryPlan(
			plan([
				change(
					"aws_iam_role.deployment",
					"aws_iam_role",
					["update"],
					{ assume_role_policy: "old" },
					{ assume_role_policy: "expanded" },
				),
			]),
		);
		expect(result.safe).toBe(false);
		expect(result.reasons.join(" ")).toContain("IAM trust mutation");
	});

	it("accepts only the expected trust policy when creating a canary role", () => {
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
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change("aws_iam_role.preflight", "aws_iam_role", ["create"], null, {
						assume_role_policy: lambdaTrust,
					}),
				]),
			),
		).toEqual({ safe: true, reasons: [] });

		const widened = classifyAgentCoreCanaryPlan(
			plan([
				change("aws_iam_role.preflight", "aws_iam_role", ["create"], null, {
					assume_role_policy: JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Action: "sts:AssumeRole",
								Principal: { AWS: "*" },
							},
						],
					}),
				}),
			]),
		);
		expect(widened.safe).toBe(false);
		expect(widened.reasons).toContain(
			"aws_iam_role.preflight has unapproved IAM trust on creation",
		);

		const statesTrust = JSON.stringify({
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Action: "sts:AssumeRole",
					Principal: { Service: "states.amazonaws.com" },
					Condition: {
						ArnLike: {
							"aws:SourceArn":
								"arn:aws:states:us-west-2:637423444544:stateMachine:mymemo-agent-agentcore-canary-prod-*",
						},
						StringEquals: { "aws:SourceAccount": "637423444544" },
					},
				},
			],
		});
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change("aws_iam_role.task", "aws_iam_role", ["create"], null, {
						assume_role_policy: statesTrust,
					}),
				]),
			),
		).toEqual({ safe: true, reasons: [] });

		for (const [sourceAccount, sourceArn] of [
			[
				"111111111111",
				"arn:aws:states:us-west-2:111111111111:stateMachine:mymemo-agent-agentcore-canary-prod-*",
			],
			[
				"637423444544",
				"arn:aws:states:eu-west-1:637423444544:stateMachine:mymemo-agent-agentcore-canary-prod-*",
			],
		] as const) {
			const foreignStatesTrust = JSON.stringify({
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: "sts:AssumeRole",
						Principal: { Service: "states.amazonaws.com" },
						Condition: {
							ArnLike: { "aws:SourceArn": sourceArn },
							StringEquals: { "aws:SourceAccount": sourceAccount },
						},
					},
				],
			});
			expect(
				classifyAgentCoreCanaryPlan(
					plan([
						change("aws_iam_role.task", "aws_iam_role", ["create"], null, {
							assume_role_policy: foreignStatesTrust,
						}),
					]),
				).safe,
			).toBe(false);
		}

		const runtimeTrust = (sourceAccount: string, sourceArn: string) =>
			JSON.stringify({
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

		for (const trust of [
			runtimeTrust(
				"111111111111",
				"arn:aws:bedrock-agentcore:us-west-2:111111111111:runtime/mymemo_agentcore_canary_prod-*",
			),
			runtimeTrust(
				"637423444544",
				"arn:aws:bedrock-agentcore:eu-west-1:637423444544:runtime/mymemo_agentcore_canary_prod-*",
			),
			runtimeTrust(
				"637423444544",
				"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/*",
			),
		]) {
			expect(
				classifyAgentCoreCanaryPlan(
					plan([
						change("aws_iam_role.runtime", "aws_iam_role", ["create"], null, {
							assume_role_policy: trust,
						}),
					]),
				).safe,
			).toBe(false);
		}

		const githubMainTrust = (
			providerAccount: string,
			subject = "repo:X-GPT/mymemo-agent:ref:refs/heads/main",
		) =>
			JSON.stringify({
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: "sts:AssumeRoleWithWebIdentity",
						Principal: {
							Federated: `arn:aws:iam::${providerAccount}:oidc-provider/token.actions.githubusercontent.com`,
						},
						Condition: {
							StringEquals: {
								"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
								"token.actions.githubusercontent.com:sub": subject,
							},
						},
					},
				],
			});
		for (const address of [
			"aws_iam_role.deployment",
			"aws_iam_role.campaign_launch",
		]) {
			expect(
				classifyAgentCoreCanaryPlan(
					plan([
						change(address, "aws_iam_role", ["create"], null, {
							assume_role_policy: githubMainTrust("637423444544"),
						}),
					]),
				),
			).toEqual({ safe: true, reasons: [] });
		}
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change("aws_iam_role.deployment", "aws_iam_role", ["create"], null, {
						assume_role_policy: githubMainTrust("111111111111"),
					}),
				]),
			).safe,
		).toBe(false);
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change(
						"aws_iam_role.campaign_launch",
						"aws_iam_role",
						["create"],
						null,
						{
							assume_role_policy: githubMainTrust(
								"637423444544",
								"repo:X-GPT/mymemo-agent:environment:production-agentcore-canary",
							),
						},
					),
				]),
			).safe,
		).toBe(false);
	});

	it("rejects widened GitHub-assumable role permissions", () => {
		const widened = JSON.stringify({
			Version: "2012-10-17",
			Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
		});
		const result = classifyAgentCoreCanaryPlan(
			plan([
				change(
					"aws_iam_role_policy.deployment",
					"aws_iam_role_policy",
					["update"],
					{ policy: "previous" },
					{ policy: widened },
				),
			]),
		);

		expect(result.safe).toBe(false);
		expect(result.reasons).toContain(
			"aws_iam_role_policy.deployment has unapproved GitHub role permissions",
		);
	});

	it("accepts only the exact campaign-launch permission", () => {
		const exact = JSON.stringify({
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Action: "lambda:InvokeFunction",
					Resource:
						"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-control",
				},
			],
		});
		expect(
			classifyAgentCoreCanaryPlan(
				plan([
					change(
						"aws_iam_role_policy.campaign_launch",
						"aws_iam_role_policy",
						["create"],
						null,
						{ policy: exact },
					),
				]),
			),
		).toEqual({ safe: true, reasons: [] });
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
