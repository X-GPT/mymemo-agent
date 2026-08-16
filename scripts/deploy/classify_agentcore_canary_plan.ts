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

const CLASSIFIER_ACCOUNT_ID = "637423444544";
const CLASSIFIER_REGION = "us-west-2";
const CANARY_RUNTIME_ARN_PATTERN = `arn:aws:bedrock-agentcore:${CLASSIFIER_REGION}:${CLASSIFIER_ACCOUNT_ID}:runtime/mymemo_agentcore_canary_prod-*`;

// This is the independent deployment boundary. It deliberately names owned
// resources and destructive operations without duplicating Terraform's IAM
// statement graph.
const CANARY_OWNED_RESOURCE_ADDRESSES = new Set([
	"aws_bedrockagentcore_agent_runtime.canary",
	"aws_cloudwatch_event_rule.repair",
	"aws_cloudwatch_event_target.repair",
	"aws_cloudwatch_metric_alarm.consumer_duration",
	"aws_cloudwatch_metric_alarm.dead_letter_work",
	"aws_cloudwatch_metric_alarm.dispatch_age",
	"aws_cloudwatch_metric_alarm.incident",
	"aws_cloudwatch_metric_alarm.lambda_errors",
	"aws_cloudwatch_metric_alarm.lambda_throttles",
	"aws_ecr_repository.runtime",
	"aws_iam_role.consumer",
	"aws_iam_role.publisher",
	"aws_iam_role.runtime",
	"aws_iam_role_policy.consumer",
	"aws_iam_role_policy.consumer_base",
	"aws_iam_role_policy.publisher",
	"aws_iam_role_policy.publisher_base",
	"aws_iam_role_policy.runtime",
	"aws_kms_alias.canary",
	"aws_kms_key.canary",
	"aws_lambda_event_source_mapping.consumer",
	"aws_lambda_function.consumer",
	"aws_lambda_function.publisher",
	"aws_lambda_permission.repair",
	"aws_route_table.private",
	"aws_route_table_association.private",
	"aws_security_group.canary",
	"aws_sqs_queue.dead_letter",
	"aws_sqs_queue.dispatch",
	"aws_ssm_parameter.enabled",
	"aws_subnet.private",
]);

const RETIRED_CONTROL_PLANE_RESOURCE_ADDRESSES = new Set([
	"aws_cloudwatch_metric_alarm.dormant_runtime_sessions",
	"aws_cloudwatch_metric_alarm.validation",
	"aws_eip.campaign",
	"aws_iam_role.control",
	"aws_iam_role.preflight",
	"aws_iam_role_policy.control",
	"aws_iam_role_policy.control_base",
	"aws_iam_role_policy.preflight",
	"aws_lambda_function.control",
	"aws_lambda_function.preflight",
	"aws_nat_gateway.campaign",
	"aws_route.campaign_egress",
]);

const RETIRED_CONTROL_PLANE_RESOURCE_INSTANCES = new Set([
	'aws_cloudwatch_metric_alarm.incident["CampaignDeadlineBreach"]',
	'aws_cloudwatch_metric_alarm.incident["CleanupResidue"]',
	'aws_cloudwatch_metric_alarm.incident["CrossLaneExecution"]',
	'aws_cloudwatch_metric_alarm.incident["NatExpiryBreach"]',
	'aws_cloudwatch_metric_alarm.lambda_errors["control"]',
	'aws_cloudwatch_metric_alarm.lambda_errors["preflight"]',
	'aws_cloudwatch_metric_alarm.lambda_throttles["control"]',
	'aws_cloudwatch_metric_alarm.lambda_throttles["preflight"]',
]);

const CANARY_OWNED_RESOURCE_TYPES = new Set(
	[
		...CANARY_OWNED_RESOURCE_ADDRESSES,
		...RETIRED_CONTROL_PLANE_RESOURCE_ADDRESSES,
	].map((address) => address.split(".")[0]),
);
const LAMBDA_ROLE_ADDRESSES = new Set([
	"aws_iam_role.consumer",
	"aws_iam_role.publisher",
]);

function resourceBaseAddress(address: string): string {
	return address.replace(/\[.*$/, "");
}

function singleStringValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (
		Array.isArray(value) &&
		value.length === 1 &&
		typeof value[0] === "string"
	) {
		return value[0];
	}
	return undefined;
}

function exactObjectKeys(
	value: Record<string, unknown>,
	expected: string[],
): boolean {
	return (
		Object.keys(value).sort().join("\0") === expected.slice().sort().join("\0")
	);
}

function parsePolicy(value: unknown): Record<string, unknown> | undefined {
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function approvedCreatedRoleTrust(address: string, value: unknown): boolean {
	const policy = parsePolicy(value);
	if (!policy || !exactObjectKeys(policy, ["Statement", "Version"]))
		return false;
	if (policy.Version !== "2012-10-17") return false;
	const statements = policy.Statement;
	if (!Array.isArray(statements) || statements.length !== 1) return false;
	const valueStatement = statements[0];
	if (
		!valueStatement ||
		typeof valueStatement !== "object" ||
		Array.isArray(valueStatement)
	) {
		return false;
	}
	const statement = valueStatement as Record<string, unknown>;
	const principal = statement.Principal;
	if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
		return false;
	}
	const principalRecord = principal as Record<string, unknown>;

	if (LAMBDA_ROLE_ADDRESSES.has(address)) {
		return (
			exactObjectKeys(statement, ["Action", "Effect", "Principal"]) &&
			statement.Effect === "Allow" &&
			singleStringValue(statement.Action) === "sts:AssumeRole" &&
			exactObjectKeys(principalRecord, ["Service"]) &&
			singleStringValue(principalRecord.Service) === "lambda.amazonaws.com"
		);
	}

	if (address !== "aws_iam_role.runtime") return false;
	const condition = statement.Condition;
	if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
		return false;
	}
	const conditionRecord = condition as Record<string, unknown>;
	const stringEquals = conditionRecord.StringEquals;
	const arnLike = conditionRecord.ArnLike;
	if (
		!stringEquals ||
		typeof stringEquals !== "object" ||
		Array.isArray(stringEquals) ||
		!arnLike ||
		typeof arnLike !== "object" ||
		Array.isArray(arnLike)
	) {
		return false;
	}
	const equalsRecord = stringEquals as Record<string, unknown>;
	const arnLikeRecord = arnLike as Record<string, unknown>;
	return (
		exactObjectKeys(statement, [
			"Action",
			"Condition",
			"Effect",
			"Principal",
		]) &&
		statement.Effect === "Allow" &&
		singleStringValue(statement.Action) === "sts:AssumeRole" &&
		exactObjectKeys(principalRecord, ["Service"]) &&
		singleStringValue(principalRecord.Service) ===
			"bedrock-agentcore.amazonaws.com" &&
		exactObjectKeys(conditionRecord, ["ArnLike", "StringEquals"]) &&
		exactObjectKeys(equalsRecord, ["aws:SourceAccount"]) &&
		singleStringValue(equalsRecord["aws:SourceAccount"]) ===
			CLASSIFIER_ACCOUNT_ID &&
		exactObjectKeys(arnLikeRecord, ["aws:SourceArn"]) &&
		singleStringValue(arnLikeRecord["aws:SourceArn"]) ===
			CANARY_RUNTIME_ARN_PATTERN
	);
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
		const baseAddress = resourceBaseAddress(address);
		const isRetiredControlPlaneResource =
			RETIRED_CONTROL_PLANE_RESOURCE_ADDRESSES.has(baseAddress) ||
			RETIRED_CONTROL_PLANE_RESOURCE_INSTANCES.has(address);
		if (
			resource.mode !== "managed" ||
			address.startsWith("module.") ||
			!CANARY_OWNED_RESOURCE_TYPES.has(type) ||
			(!CANARY_OWNED_RESOURCE_ADDRESSES.has(baseAddress) &&
				!isRetiredControlPlaneResource)
		) {
			reasons.push(`${address} is outside canary ownership (${type})`);
		}
		if (
			isRetiredControlPlaneResource &&
			(actions.length !== 1 || actions[0] !== "delete")
		) {
			reasons.push(
				`${address} is retired control-plane infrastructure and may only be deleted`,
			);
		} else if (!isRetiredControlPlaneResource && actions.includes("delete")) {
			reasons.push(`${address} requests deletion or replacement`);
		}
		if (actions.includes("forget")) {
			reasons.push(`${address} requests removal from Terraform state`);
		}
		if (
			type === "aws_iam_role" &&
			actions.includes("create") &&
			!approvedCreatedRoleTrust(
				baseAddress,
				resource.change?.after?.assume_role_policy,
			)
		) {
			reasons.push(`${address} has unapproved IAM trust on creation`);
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
