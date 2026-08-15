#!/usr/bin/env bun
import { readFileSync } from "node:fs";

interface PlanChange {
	address?: string;
	mode?: string;
	type?: string;
	change?: {
		actions?: string[];
		before?: Record<string, unknown> | null;
		after?: Record<string, unknown> | null;
	};
}

interface TerraformPlan {
	resource_changes?: PlanChange[];
}

export interface PlanClassification {
	safe: boolean;
	reasons: string[];
}

// This explicit list is an independent, fail-closed safety boundary. Do not
// derive it from the Terraform under classification: every new owned resource
// must be reviewed and added here deliberately.
const CANARY_OWNED_RESOURCE_ADDRESSES = new Set([
	"aws_bedrockagentcore_agent_runtime.canary",
	"aws_cloudwatch_event_rule.repair",
	"aws_cloudwatch_event_target.repair",
	"aws_cloudwatch_metric_alarm.consumer_duration",
	"aws_cloudwatch_metric_alarm.dead_letter_work",
	"aws_cloudwatch_metric_alarm.dispatch_age",
	"aws_cloudwatch_metric_alarm.dormant_runtime_sessions",
	"aws_cloudwatch_metric_alarm.incident",
	"aws_cloudwatch_metric_alarm.lambda_errors",
	"aws_cloudwatch_metric_alarm.lambda_throttles",
	"aws_cloudwatch_metric_alarm.validation",
	"aws_ecr_lifecycle_policy.runtime",
	"aws_ecr_repository.runtime",
	"aws_eip.campaign",
	"aws_iam_role.campaign_launch",
	"aws_iam_role.consumer",
	"aws_iam_role.control",
	"aws_iam_role.deployment",
	"aws_iam_role.fault_injection",
	"aws_iam_role.preflight",
	"aws_iam_role.publisher",
	"aws_iam_role.runtime",
	"aws_iam_role.task",
	"aws_iam_role_policy.campaign_launch",
	"aws_iam_role_policy.consumer",
	"aws_iam_role_policy.consumer_base",
	"aws_iam_role_policy.control",
	"aws_iam_role_policy.control_base",
	"aws_iam_role_policy.deployment",
	"aws_iam_role_policy.fault_injection",
	"aws_iam_role_policy.preflight",
	"aws_iam_role_policy.publisher",
	"aws_iam_role_policy.publisher_base",
	"aws_iam_role_policy.runtime",
	"aws_iam_role_policy.task",
	"aws_kms_alias.canary",
	"aws_kms_key.canary",
	"aws_lambda_event_source_mapping.consumer",
	"aws_lambda_function.consumer",
	"aws_lambda_function.control",
	"aws_lambda_function.preflight",
	"aws_lambda_function.publisher",
	"aws_lambda_permission.repair",
	"aws_nat_gateway.campaign",
	"aws_route.campaign_egress",
	"aws_route_table.private",
	"aws_route_table_association.private",
	"aws_security_group.canary",
	"aws_sqs_queue.dead_letter",
	"aws_sqs_queue.dispatch",
	"aws_ssm_parameter.enabled",
	"aws_subnet.private",
]);

const CANARY_OWNED_RESOURCE_TYPES = new Set(
	[...CANARY_OWNED_RESOURCE_ADDRESSES].map((address) => address.split(".")[0]),
);

function resourceBaseAddress(address: string): string {
	return address.replace(/\[.*$/, "");
}

export function classifyAgentCoreCanaryPlan(
	plan: TerraformPlan,
): PlanClassification {
	const reasons: string[] = [];
	for (const resource of plan.resource_changes ?? []) {
		const actions = resource.change?.actions ?? [];
		if (actions.every((action) => action === "no-op" || action === "read")) {
			continue;
		}
		const address = resource.address ?? "<unknown>";
		const type = resource.type ?? "<unknown>";
		if (
			resource.mode !== "managed" ||
			address.startsWith("module.") ||
			!CANARY_OWNED_RESOURCE_TYPES.has(type) ||
			!CANARY_OWNED_RESOURCE_ADDRESSES.has(resourceBaseAddress(address))
		) {
			reasons.push(`${address} is outside canary ownership (${type})`);
		}
		if (actions.includes("delete")) {
			reasons.push(`${address} requests deletion or replacement`);
		}
		if (actions.includes("forget")) {
			reasons.push(`${address} requests removal from Terraform state`);
		}
		if (
			type === "aws_iam_role" &&
			actions.includes("update") &&
			resource.change?.before?.assume_role_policy !==
				resource.change?.after?.assume_role_policy
		) {
			reasons.push(`${address} requests IAM trust mutation`);
		}
	}
	return { safe: reasons.length === 0, reasons };
}

export function verifyAgentCoreProviderLock(
	lockfile: string,
): PlanClassification {
	const reasons: string[] = [];
	const awsProviderBlock = lockfile.match(
		/provider "registry\.terraform\.io\/hashicorp\/aws" \{([\s\S]*?)\n\}/,
	)?.[1];
	const version = awsProviderBlock
		?.match(/version\s*=\s*"(\d+)\.(\d+)\.(\d+)"/)
		?.slice(1);
	const constraints = awsProviderBlock?.match(
		/constraints\s*=\s*"([^"]+)"/,
	)?.[1];
	if (!version) {
		reasons.push("AWS provider lock version is missing");
	} else {
		const [major, minor] = version.map(Number);
		if (major !== 6 || minor < 50) {
			reasons.push(`AWS provider ${version.join(".")} is outside >= 6.50, < 7`);
		}
	}
	if (!constraints?.includes(">= 6.50") || !constraints.includes("< 7.0")) {
		reasons.push("AWS provider constraint must remain >= 6.50, < 7.0");
	}
	return { safe: reasons.length === 0, reasons };
}

if (import.meta.main) {
	const planPath = process.argv[2];
	const lockPath = process.argv[3];
	if (!planPath || !lockPath) {
		console.error(
			"Usage: classify_agentcore_canary_plan.ts <plan.json> <.terraform.lock.hcl>",
		);
		process.exit(2);
	}
	const planResult = classifyAgentCoreCanaryPlan(
		JSON.parse(readFileSync(planPath, "utf8")),
	);
	const providerResult = verifyAgentCoreProviderLock(
		readFileSync(lockPath, "utf8"),
	);
	const reasons = [...providerResult.reasons, ...planResult.reasons];
	if (reasons.length > 0) {
		for (const reason of reasons) console.error(`REJECT: ${reason}`);
		process.exit(1);
	}
	console.log("safe-canary-plan");
}
