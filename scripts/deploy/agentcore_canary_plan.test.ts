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
