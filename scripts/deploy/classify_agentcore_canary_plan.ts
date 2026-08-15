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

const LAMBDA_ROLE_ADDRESSES = new Set([
	"aws_iam_role.consumer",
	"aws_iam_role.control",
	"aws_iam_role.preflight",
	"aws_iam_role.publisher",
]);
const STATES_ROLE_ADDRESSES = new Set([
	"aws_iam_role.fault_injection",
	"aws_iam_role.task",
]);
const GITHUB_ROLE_ADDRESSES = new Set([
	"aws_iam_role.campaign_launch",
	"aws_iam_role.deployment",
]);

function oneString(value: unknown): string | undefined {
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

function exactObjectKeys(
	value: Record<string, unknown>,
	expected: string[],
): boolean {
	return (
		Object.keys(value).sort().join("\0") === expected.slice().sort().join("\0")
	);
}

function approvedCreatedRoleTrust(address: string, value: unknown): boolean {
	const policy = parsePolicy(value);
	if (!policy || !exactObjectKeys(policy, ["Statement", "Version"]))
		return false;
	const statements = policy.Statement;
	if (!Array.isArray(statements) || statements.length !== 1) return false;
	const statement = statements[0];
	if (!statement || typeof statement !== "object" || Array.isArray(statement))
		return false;
	const trust = statement as Record<string, unknown>;
	if (trust.Effect !== "Allow") return false;
	const principal = trust.Principal;
	if (!principal || typeof principal !== "object" || Array.isArray(principal))
		return false;
	const principalRecord = principal as Record<string, unknown>;

	if (LAMBDA_ROLE_ADDRESSES.has(address)) {
		return (
			exactObjectKeys(trust, ["Action", "Effect", "Principal"]) &&
			oneString(trust.Action) === "sts:AssumeRole" &&
			exactObjectKeys(principalRecord, ["Service"]) &&
			oneString(principalRecord.Service) === "lambda.amazonaws.com"
		);
	}

	const condition = trust.Condition;
	if (!condition || typeof condition !== "object" || Array.isArray(condition))
		return false;
	const conditionRecord = condition as Record<string, unknown>;
	const stringEquals = conditionRecord.StringEquals;
	if (
		!stringEquals ||
		typeof stringEquals !== "object" ||
		Array.isArray(stringEquals)
	) {
		return false;
	}
	const equalsRecord = stringEquals as Record<string, unknown>;

	if (STATES_ROLE_ADDRESSES.has(address)) {
		return (
			exactObjectKeys(trust, ["Action", "Condition", "Effect", "Principal"]) &&
			oneString(trust.Action) === "sts:AssumeRole" &&
			exactObjectKeys(principalRecord, ["Service"]) &&
			oneString(principalRecord.Service) === "states.amazonaws.com" &&
			exactObjectKeys(conditionRecord, ["StringEquals"]) &&
			exactObjectKeys(equalsRecord, ["aws:SourceAccount"]) &&
			/^\d{12}$/.test(oneString(equalsRecord["aws:SourceAccount"]) ?? "")
		);
	}

	if (address === "aws_iam_role.runtime") {
		const arnLike = conditionRecord.ArnLike;
		if (!arnLike || typeof arnLike !== "object" || Array.isArray(arnLike))
			return false;
		const arnLikeRecord = arnLike as Record<string, unknown>;
		return (
			exactObjectKeys(trust, ["Action", "Condition", "Effect", "Principal"]) &&
			oneString(trust.Action) === "sts:AssumeRole" &&
			exactObjectKeys(principalRecord, ["Service"]) &&
			oneString(principalRecord.Service) ===
				"bedrock-agentcore.amazonaws.com" &&
			exactObjectKeys(conditionRecord, ["ArnLike", "StringEquals"]) &&
			exactObjectKeys(equalsRecord, ["aws:SourceAccount"]) &&
			/^\d{12}$/.test(oneString(equalsRecord["aws:SourceAccount"]) ?? "") &&
			exactObjectKeys(arnLikeRecord, ["aws:SourceArn"]) &&
			/^arn:aws:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/\*$/.test(
				oneString(arnLikeRecord["aws:SourceArn"]) ?? "",
			)
		);
	}

	if (GITHUB_ROLE_ADDRESSES.has(address)) {
		return (
			exactObjectKeys(trust, ["Action", "Condition", "Effect", "Principal"]) &&
			oneString(trust.Action) === "sts:AssumeRoleWithWebIdentity" &&
			exactObjectKeys(principalRecord, ["Federated"]) &&
			/^arn:aws:iam::\d{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/.test(
				oneString(principalRecord.Federated) ?? "",
			) &&
			exactObjectKeys(conditionRecord, ["StringEquals"]) &&
			exactObjectKeys(equalsRecord, [
				"token.actions.githubusercontent.com:aud",
				"token.actions.githubusercontent.com:sub",
			]) &&
			oneString(equalsRecord["token.actions.githubusercontent.com:aud"]) ===
				"sts.amazonaws.com" &&
			oneString(equalsRecord["token.actions.githubusercontent.com:sub"]) ===
				"repo:X-GPT/mymemo-agent:environment:production-agentcore-canary"
		);
	}

	return false;
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
			actions.includes("create") &&
			!approvedCreatedRoleTrust(
				resourceBaseAddress(address),
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
