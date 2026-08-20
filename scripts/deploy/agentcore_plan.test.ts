import { describe, expect, it } from "bun:test";
import { classifyTerraformPlan } from "./classify_terraform_plan";

function plan(changes: unknown[]) {
	return { format_version: "1.2", resource_changes: changes };
}

function change(
	address: string,
	actions: string[],
	before: unknown = null,
	after: unknown = {},
) {
	return {
		address,
		mode: "managed",
		change: { actions, before, after },
	};
}

describe("unified production Terraform plan classification", () => {
	it("allows the routine ECS, consumer, and Runtime release together", () => {
		expect(
			classifyTerraformPlan(
				plan([
					change("aws_ecs_task_definition.agent_worker", ["delete", "create"]),
					change("aws_lambda_function.consumer", ["update"]),
					change("aws_bedrockagentcore_agent_runtime.runtime", ["update"]),
				]),
			),
		).toEqual({ lane: "app", reasons: [], fatalReasons: [] });
	});

	it("routes infrastructure creation, deletion, and replacement to manual review", () => {
		for (const [address, actions] of [
			["aws_sqs_queue.dispatch", ["create"]],
			["aws_lambda_function.consumer", ["delete", "create"]],
			["aws_bedrockagentcore_agent_runtime.runtime", ["delete", "create"]],
		] as const) {
			const result = classifyTerraformPlan(
				plan([change(address, [...actions])]),
			);
			expect(result.lane).toBe("infra");
			expect(result.reasons).toContain(
				`${address} changes outside the routine application release`,
			);
			expect(result.fatalReasons).toEqual([]);
		}
	});

	it("routes workload trust changes to manual review", () => {
		const result = classifyTerraformPlan(
			plan([
				change(
					"aws_iam_role.runtime",
					["update"],
					{ assume_role_policy: "old" },
					{ assume_role_policy: "new" },
				),
			]),
		);
		expect(result.lane).toBe("infra");
		expect(result.reasons).toContain(
			"aws_iam_role.runtime changes a workload IAM trust policy",
		);
	});

	it("rejects removal from Terraform state in either lane", () => {
		const result = classifyTerraformPlan(
			plan([change("aws_lambda_function.consumer", ["forget"])]),
		);
		expect(result.lane).toBe("infra");
		expect(result.fatalReasons).toContain(
			"aws_lambda_function.consumer requests removal from Terraform state",
		);
	});

	it("ignores data reads and treats an empty plan as app-safe", () => {
		expect(
			classifyTerraformPlan(
				plan([
					{
						address: "data.aws_caller_identity.current",
						mode: "data",
						change: { actions: ["read"] },
					},
				]),
			),
		).toEqual({ lane: "app", reasons: [], fatalReasons: [] });
	});
});
