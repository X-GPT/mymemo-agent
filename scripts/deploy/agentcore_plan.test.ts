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
				]),
			),
		).toEqual({ safe: true, reasons: [] });
	});

	it("allows only exact one-time canary-to-production replacements", () => {
		for (const [address, type, field, before, after] of [
			[
				"aws_bedrockagentcore_agent_runtime.runtime",
				"aws_bedrockagentcore_agent_runtime",
				"agent_runtime_name",
				"mymemo_agentcore_canary_prod",
				"mymemo_agentcore_prod",
			],
			[
				"aws_lambda_function.consumer",
				"aws_lambda_function",
				"function_name",
				"mymemo-agent-agentcore-canary-prod-consumer",
				"mymemo-agent-agentcore-prod-consumer",
			],
			[
				"aws_sqs_queue.dispatch",
				"aws_sqs_queue",
				"name",
				"mymemo-agent-agentcore-canary-prod-dispatch",
				"mymemo-agent-agentcore-prod-dispatch",
			],
		] as const) {
			expect(
				classifyAgentCorePlan(
					plan([
						change(
							address,
							type,
							["delete", "create"],
							{ [field]: before },
							{ [field]: after },
						),
					]),
				),
			).toEqual({ safe: true, reasons: [] });
		}

		const rejected = classifyAgentCorePlan(
			plan([
				change(
					"aws_sqs_queue.dispatch",
					"aws_sqs_queue",
					["delete", "create"],
					{ name: "mymemo-agent-agentcore-prod-dispatch" },
					{ name: "unexpected" },
				),
			]),
		);
		expect(rejected.safe).toBe(false);
		expect(rejected.reasons.join(" ")).toContain(
			"unapproved deletion or replacement",
		);
	});

	it("approves the exact event-source mapping replacement forced by the queue rename", () => {
		const oldQueueArn =
			"arn:aws:sqs:us-west-2:637423444544:mymemo-agent-agentcore-canary-prod-dispatch";
		const productionQueueArn =
			"arn:aws:sqs:us-west-2:637423444544:mymemo-agent-agentcore-prod-dispatch";
		const oldConsumerArn =
			"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-consumer";
		const productionConsumerArn =
			"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-prod-consumer";
		const mappingReplacement = change(
			"aws_lambda_event_source_mapping.consumer",
			"aws_lambda_event_source_mapping",
			["delete", "create"],
			{ event_source_arn: oldQueueArn, function_name: oldConsumerArn },
			{
				event_source_arn: productionQueueArn,
				function_name: productionConsumerArn,
			},
		);
		const queueReplacement = change(
			"aws_sqs_queue.dispatch",
			"aws_sqs_queue",
			["delete", "create"],
			{ name: "mymemo-agent-agentcore-canary-prod-dispatch" },
			{ name: "mymemo-agent-agentcore-prod-dispatch" },
		);

		expect(
			classifyAgentCorePlan(plan([queueReplacement, mappingReplacement])),
		).toEqual({ safe: true, reasons: [] });

		const wrongMapping = structuredClone(mappingReplacement);
		wrongMapping.change.after.function_name = oldConsumerArn;
		expect(classifyAgentCorePlan(plan([wrongMapping])).safe).toBe(false);
	});

	it("keeps the legacy Runtime repository managed until its copied digest is safe to delete", () => {
		for (const repositoryChange of [
			change(
				"aws_ecr_repository.production_runtime",
				"aws_ecr_repository",
				["create"],
				null,
				{ name: "mymemo/agentcore-runtime", force_delete: false },
			),
			change(
				"aws_ecr_repository.legacy_runtime[0]",
				"aws_ecr_repository",
				["update"],
				{ name: "mymemo/agentcore-canary-runtime", force_delete: false },
				{ name: "mymemo/agentcore-canary-runtime", force_delete: true },
			),
			change(
				"aws_ecr_repository.legacy_runtime[0]",
				"aws_ecr_repository",
				["delete"],
				{ name: "mymemo/agentcore-canary-runtime", force_delete: true },
				null,
			),
		]) {
			expect(classifyAgentCorePlan(plan([repositoryChange]))).toEqual({
				safe: true,
				reasons: [],
			});
		}

		const wrongLegacyDelete = change(
			"aws_ecr_repository.legacy_runtime[0]",
			"aws_ecr_repository",
			["delete"],
			{ name: "unrelated", force_delete: true },
			null,
		);
		expect(classifyAgentCorePlan(plan([wrongLegacyDelete])).safe).toBe(false);
	});

	it("allows deletion only for exact retired publisher and canary resources", () => {
		for (const [address, type] of [
			["aws_lambda_function.publisher", "aws_lambda_function"],
			["aws_iam_role.publisher", "aws_iam_role"],
			["aws_iam_role_policy.publisher", "aws_iam_role_policy"],
			["aws_cloudwatch_event_rule.repair", "aws_cloudwatch_event_rule"],
			["aws_cloudwatch_event_target.repair", "aws_cloudwatch_event_target"],
			["aws_lambda_permission.repair", "aws_lambda_permission"],
			[
				'aws_cloudwatch_metric_alarm.incident["PoisonDispatch"]',
				"aws_cloudwatch_metric_alarm",
			],
			[
				'aws_cloudwatch_metric_alarm.lambda_errors["publisher"]',
				"aws_cloudwatch_metric_alarm",
			],
		] as const) {
			expect(
				classifyAgentCorePlan(plan([change(address, type, ["delete"])])),
			).toEqual({ safe: true, reasons: [] });
		}

		const result = classifyAgentCorePlan(
			plan([
				change("aws_lambda_function.publisher", "aws_lambda_function", [
					"create",
				]),
			]),
		);
		expect(result.safe).toBe(false);
		expect(result.reasons.join(" ")).toContain("may only be deleted");
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
