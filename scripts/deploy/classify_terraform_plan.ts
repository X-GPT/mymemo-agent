#!/usr/bin/env bun
import { readFileSync } from "node:fs";

interface ResourceChange {
	address?: string;
	mode?: string;
	change?: {
		actions?: string[];
		before?: Record<string, unknown> | null;
		after?: Record<string, unknown> | null;
	};
}

interface TerraformPlan {
	resource_changes?: ResourceChange[];
}

export interface PlanClassification {
	lane: "app" | "infra";
	reasons: string[];
	fatalReasons: string[];
}

const ROUTINE_APP_ACTIONS = new Map<string, Set<string>>([
	["aws_ecs_task_definition.chat_api", new Set(["create", "delete", "update"])],
	[
		"aws_ecs_task_definition.agent_worker",
		new Set(["create", "delete", "update"]),
	],
	[
		"aws_ecs_task_definition.agentcore_dispatch_publisher",
		new Set(["create", "delete", "update"]),
	],
	[
		"aws_ecs_task_definition.agent_migration",
		new Set(["create", "delete", "update"]),
	],
	["aws_ecs_service.chat_api", new Set(["update"])],
	["aws_ecs_service.agent_worker", new Set(["update"])],
	["aws_ecs_service.agentcore_dispatch_publisher", new Set(["update"])],
	["aws_lambda_function.consumer", new Set(["update"])],
	["aws_bedrockagentcore_agent_runtime.runtime", new Set(["update"])],
]);

const WORKLOAD_ROLE_ADDRESSES = new Set([
	"aws_iam_role.consumer",
	"aws_iam_role.runtime",
]);

function changedActions(change: ResourceChange): string[] {
	return (change.change?.actions ?? []).filter(
		(action) => action !== "no-op" && action !== "read",
	);
}

export function classifyTerraformPlan(plan: TerraformPlan): PlanClassification {
	const reasons: string[] = [];
	const fatalReasons: string[] = [];

	for (const resource of plan.resource_changes ?? []) {
		const actions = changedActions(resource);
		if (actions.length === 0) continue;

		const address = resource.address ?? "<unknown>";
		if (actions.includes("forget")) {
			fatalReasons.push(`${address} requests removal from Terraform state`);
			continue;
		}

		if (
			WORKLOAD_ROLE_ADDRESSES.has(address) &&
			resource.change?.before?.assume_role_policy !==
				resource.change?.after?.assume_role_policy
		) {
			reasons.push(`${address} changes a workload IAM trust policy`);
			continue;
		}

		const allowedActions = ROUTINE_APP_ACTIONS.get(address);
		if (
			resource.mode !== "managed" ||
			!allowedActions ||
			actions.some((action) => !allowedActions.has(action))
		) {
			reasons.push(
				`${address} changes outside the routine application release`,
			);
		}
	}

	return {
		lane: reasons.length === 0 && fatalReasons.length === 0 ? "app" : "infra",
		reasons,
		fatalReasons,
	};
}

function readSavedTerraformPlan(planPath: string): TerraformPlan {
	if (planPath.endsWith(".json")) {
		return JSON.parse(readFileSync(planPath, "utf8"));
	}

	const show = Bun.spawnSync({
		cmd: ["terraform", "-chdir=infra/terraform", "show", "-json", planPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (show.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(show.stderr).trim());
	}
	return JSON.parse(new TextDecoder().decode(show.stdout));
}

if (import.meta.main) {
	const planPath = process.argv[2] ?? "agent-prod.tfplan";
	let result: PlanClassification;
	try {
		result = classifyTerraformPlan(readSavedTerraformPlan(planPath));
	} catch (error) {
		console.error(
			`Unable to read Terraform plan ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
	for (const reason of result.reasons) console.error(`INFRA: ${reason}`);
	for (const reason of result.fatalReasons) console.error(`REJECT: ${reason}`);
	if (result.fatalReasons.length > 0) process.exit(2);
	console.log(result.lane);
}
