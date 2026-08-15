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

// These values are intentionally classifier-owned. Importing them from the
// Terraform under review would let one boundary change approve itself.
const CLASSIFIER_ACCOUNT_ID = "637423444544";
const CLASSIFIER_REGION = "us-west-2";
const CLASSIFIER_RESOURCE_PREFIX = "mymemo-agent-agentcore-canary-prod";
const CLASSIFIER_RUNTIME_PREFIX = "mymemo_agentcore_canary_prod";
const DEPLOYMENT_ROLE_POLICY_ADDRESS = "aws_iam_role_policy.deployment";

function regionalArn(service: string, resource: string): string {
	return `arn:aws:${service}:${CLASSIFIER_REGION}:${CLASSIFIER_ACCOUNT_ID}:${resource}`;
}

function iamArn(resource: string): string {
	return `arn:aws:iam::${CLASSIFIER_ACCOUNT_ID}:${resource}`;
}

function canaryRoleArn(suffix: string): string {
	return iamArn(`role/${CLASSIFIER_RESOURCE_PREFIX}-${suffix}`);
}

function canaryFunctionArn(suffix: string): string {
	return regionalArn(
		"lambda",
		`function:${CLASSIFIER_RESOURCE_PREFIX}-${suffix}`,
	);
}

const CANARY_RUNTIME_ARN_PATTERN = regionalArn(
	"bedrock-agentcore",
	`runtime/${CLASSIFIER_RUNTIME_PREFIX}-*`,
);
const CANARY_STATE_MACHINE_ARN_PATTERN = regionalArn(
	"states",
	`stateMachine:${CLASSIFIER_RESOURCE_PREFIX}-*`,
);
const CANARY_REPAIR_RULE_ARN = regionalArn(
	"events",
	`rule/${CLASSIFIER_RESOURCE_PREFIX}-repair`,
);
const CANARY_PUBLISHER_ARN = canaryFunctionArn("publisher");
const CANARY_CONSUMER_ARN = canaryFunctionArn("consumer");

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
	"aws_iam_role.consumer",
	"aws_iam_role.control",
	"aws_iam_role.deployment",
	"aws_iam_role.fault_injection",
	"aws_iam_role.preflight",
	"aws_iam_role.publisher",
	"aws_iam_role.runtime",
	"aws_iam_role.task",
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
const GITHUB_ROLE_ADDRESSES = new Set(["aws_iam_role.deployment"]);

interface PolicyRule {
	actions: string[];
	resourcePatterns: (string | RegExp)[];
	conditions?: Record<string, Record<string, (string | RegExp)[]>>;
}

const LAMBDA_PASS_ROLE_SUFFIXES = {
	PassConsumerRoleOnly: "consumer",
	PassControlRoleOnly: "control",
	PassPreflightRoleOnly: "preflight",
	PassPublisherRoleOnly: "publisher",
} as const;

function lambdaPassRoleRule(suffix: string): PolicyRule {
	return {
		actions: ["iam:PassRole"],
		resourcePatterns: [canaryRoleArn(suffix)],
		conditions: {
			ArnEquals: {
				"iam:AssociatedResourceArn": [canaryFunctionArn(suffix)],
			},
			StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com"] },
		},
	};
}

const LAMBDA_PASS_ROLE_RULES = Object.fromEntries(
	Object.entries(LAMBDA_PASS_ROLE_SUFFIXES).map(([sid, suffix]) => [
		sid,
		lambdaPassRoleRule(suffix),
	]),
) as Record<string, PolicyRule>;

const DEPLOYMENT_POLICY_RULES: Record<string, PolicyRule> = {
	DedicatedTerraformStateBucket: {
		actions: ["s3:GetBucketVersioning", "s3:ListBucket"],
		resourcePatterns: ["arn:aws:s3:::mymemo-terraform-state-bucket"],
	},
	DedicatedTerraformState: {
		actions: ["s3:GetObject", "s3:PutObject"],
		resourcePatterns: [
			"arn:aws:s3:::mymemo-terraform-state-bucket/mymemo-agent/agentcore-canary-prod.tfstate",
		],
	},
	DedicatedTerraformLock: {
		actions: ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"],
		resourcePatterns: [
			"arn:aws:s3:::mymemo-terraform-state-bucket/mymemo-agent/agentcore-canary-prod.tfstate.tflock",
		],
	},
	ReadOnlySharedTerraformOutputs: {
		actions: ["s3:GetObject"],
		resourcePatterns: [
			"arn:aws:s3:::mymemo-terraform-state-bucket/mymemo-agent/prod.tfstate",
		],
	},
	ReadCanaryControlPlane: {
		actions: [
			"bedrock-agentcore:GetAgentRuntime",
			"bedrock-agentcore:GetAgentRuntimeEndpoint",
			"bedrock-agentcore:ListAgentRuntimeEndpoints",
			"bedrock-agentcore:ListAgentRuntimeVersions",
			"bedrock-agentcore:ListTagsForResource",
			"cloudwatch:DescribeAlarms",
			"cloudwatch:GetMetricStatistics",
			"cloudwatch:ListTagsForResource",
			"ec2:Describe*",
			"ecr:GetAuthorizationToken",
			"events:DescribeRule",
			"events:ListTagsForResource",
			"events:ListTargetsByRule",
			"iam:GetOpenIDConnectProvider",
			"iam:GetRole",
			"iam:GetRolePolicy",
			"iam:ListRolePolicies",
			"iam:ListRoleTags",
			"kms:DescribeKey",
			"kms:GetKeyPolicy",
			"kms:GetKeyRotationStatus",
			"kms:ListAliases",
			"kms:ListResourceTags",
			"lambda:GetEventSourceMapping",
			"lambda:GetFunction",
			"lambda:GetFunctionCodeSigningConfig",
			"lambda:GetFunctionConcurrency",
			"lambda:GetFunctionConfiguration",
			"lambda:GetPolicy",
			"lambda:GetRuntimeManagementConfig",
			"lambda:ListEventSourceMappings",
			"lambda:ListTags",
			"sqs:GetQueueAttributes",
			"sqs:GetQueueUrl",
			"sqs:ListQueueTags",
			"ssm:DescribeParameters",
			"ssm:ListTagsForResource",
		],
		resourcePatterns: ["*"],
	},
	ReadCanaryRepositoryOnly: {
		actions: [
			"ecr:BatchCheckLayerAvailability",
			"ecr:BatchGetImage",
			"ecr:DescribeImages",
			"ecr:DescribeImageScanFindings",
			"ecr:DescribeRepositories",
			"ecr:GetDownloadUrlForLayer",
			"ecr:ListImages",
			"ecr:ListTagsForResource",
		],
		resourcePatterns: [
			regionalArn("ecr", "repository/mymemo/agentcore-canary-runtime"),
		],
	},
	ReadCanaryEnablementOnly: {
		actions: ["ssm:GetParameter"],
		resourcePatterns: [
			regionalArn("ssm", "parameter/mymemo/agentcore-canary/prod/enabled"),
		],
	},
	CreateCanaryRuntimeOnly: {
		actions: ["bedrock-agentcore:CreateAgentRuntime"],
		resourcePatterns: ["*"],
		conditions: {
			"ForAllValues:StringEquals": {
				"aws:TagKeys": ["Application", "Environment", "ManagedBy"],
				"bedrock-agentcore:securityGroups": Array.from(
					{ length: 3 },
					() => /^sg-[0-9a-f]+$/,
				),
				"bedrock-agentcore:subnets": Array.from(
					{ length: 2 },
					() => /^subnet-[0-9a-f]+$/,
				),
			},
			StringEquals: {
				"aws:RequestTag/Application": ["mymemo-agentcore-canary"],
				"aws:RequestTag/Environment": ["prod"],
				"aws:RequestTag/ManagedBy": ["terraform"],
			},
			Null: {
				"bedrock-agentcore:securityGroups": ["false"],
				"bedrock-agentcore:subnets": ["false"],
			},
		},
	},
	ManageCanaryRuntimeOnly: {
		actions: [
			"bedrock-agentcore:CreateAgentRuntimeEndpoint",
			"bedrock-agentcore:TagResource",
		],
		resourcePatterns: [CANARY_RUNTIME_ARN_PATTERN],
	},
	UpdateCanaryRuntimeOnly: {
		actions: ["bedrock-agentcore:UpdateAgentRuntime"],
		resourcePatterns: [CANARY_RUNTIME_ARN_PATTERN],
		conditions: {
			"ForAllValues:StringEquals": {
				"bedrock-agentcore:securityGroups": Array.from(
					{ length: 3 },
					() => /^sg-[0-9a-f]+$/,
				),
				"bedrock-agentcore:subnets": Array.from(
					{ length: 2 },
					() => /^subnet-[0-9a-f]+$/,
				),
			},
			Null: {
				"bedrock-agentcore:securityGroups": ["false"],
				"bedrock-agentcore:subnets": ["false"],
			},
		},
	},
	ManageCanaryAlarmsOnly: {
		actions: [
			"cloudwatch:DeleteAlarms",
			"cloudwatch:PutMetricAlarm",
			"cloudwatch:TagResource",
		],
		resourcePatterns: [
			regionalArn("cloudwatch", `alarm:${CLASSIFIER_RESOURCE_PREFIX}-*`),
		],
	},
	ManageCanaryRepositoryOnly: {
		actions: [
			"ecr:CompleteLayerUpload",
			"ecr:CreateRepository",
			"ecr:InitiateLayerUpload",
			"ecr:PutImage",
			"ecr:PutImageScanningConfiguration",
			"ecr:PutImageTagMutability",
			"ecr:TagResource",
			"ecr:UploadLayerPart",
		],
		resourcePatterns: [
			regionalArn("ecr", "repository/mymemo/agentcore-canary-runtime"),
		],
	},
	ManageCanaryRepairRuleOnly: {
		actions: ["events:DisableRule"],
		resourcePatterns: [CANARY_REPAIR_RULE_ARN],
	},
	ManageCanaryRepairTargetOnly: {
		actions: ["events:PutTargets"],
		resourcePatterns: [CANARY_REPAIR_RULE_ARN],
		conditions: {
			"ForAnyValue:ArnEquals": {
				"events:TargetArn": [CANARY_PUBLISHER_ARN],
			},
		},
	},
	ManageCanaryFunctionsOnly: {
		actions: [
			"lambda:CreateFunction",
			"lambda:PutFunctionConcurrency",
			"lambda:TagResource",
			"lambda:UpdateFunctionCode",
			"lambda:UpdateFunctionConfiguration",
		],
		resourcePatterns: [canaryFunctionArn("*")],
	},
	ManageCanaryRepairPermissionOnly: {
		actions: ["lambda:AddPermission"],
		resourcePatterns: [CANARY_PUBLISHER_ARN],
		conditions: {
			StringEquals: {
				"lambda:Principal": ["events.amazonaws.com"],
			},
		},
	},
	CreateCanaryEventMappingOnly: {
		actions: ["lambda:CreateEventSourceMapping"],
		resourcePatterns: ["*"],
		conditions: {
			ArnLike: {
				"lambda:FunctionArn": [CANARY_CONSUMER_ARN],
			},
		},
	},
	UpdateCanaryEventMappingOnly: {
		actions: ["lambda:UpdateEventSourceMapping"],
		resourcePatterns: [regionalArn("lambda", "event-source-mapping:*")],
		conditions: {
			ArnLike: {
				"lambda:FunctionArn": [CANARY_CONSUMER_ARN],
			},
		},
	},
	ManageCanaryQueuesOnly: {
		actions: ["sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:TagQueue"],
		resourcePatterns: [regionalArn("sqs", `${CLASSIFIER_RESOURCE_PREFIX}-*`)],
	},
	ManageCanaryParameterOnly: {
		actions: ["ssm:AddTagsToResource", "ssm:PutParameter"],
		resourcePatterns: [
			regionalArn("ssm", "parameter/mymemo/agentcore-canary/prod/*"),
		],
	},
	InspectCanaryRolesOnly: {
		actions: ["iam:SimulatePrincipalPolicy"],
		resourcePatterns: [canaryRoleArn("*")],
	},
	...LAMBDA_PASS_ROLE_RULES,
	PassRuntimeRoleOnly: {
		actions: ["iam:PassRole"],
		resourcePatterns: [canaryRoleArn("runtime")],
		conditions: {
			ArnLike: {
				"iam:AssociatedResourceArn": [CANARY_RUNTIME_ARN_PATTERN],
			},
			StringEquals: {
				"iam:PassedToService": ["bedrock-agentcore.amazonaws.com"],
			},
		},
	},
	CreateTaggedCanaryNetworkAndKey: {
		actions: [
			"ec2:AllocateAddress",
			"ec2:CreateNatGateway",
			"ec2:CreateRouteTable",
			"ec2:CreateSecurityGroup",
			"ec2:CreateSubnet",
			"kms:CreateKey",
		],
		resourcePatterns: ["*"],
		conditions: {
			StringEquals: {
				"aws:RequestTag/Application": ["mymemo-agentcore-canary"],
			},
		},
	},
	TagCanaryNetworkOnCreate: {
		actions: ["ec2:CreateTags"],
		resourcePatterns: ["*"],
		conditions: {
			StringEquals: {
				"aws:RequestTag/Application": ["mymemo-agentcore-canary"],
				"ec2:CreateAction": [
					"AllocateAddress",
					"CreateNatGateway",
					"CreateRouteTable",
					"CreateSecurityGroup",
					"CreateSubnet",
				],
			},
		},
	},
	ManageTaggedCanaryNetworkAndKey: {
		actions: [
			"ec2:AssociateRouteTable",
			"ec2:AuthorizeSecurityGroupEgress",
			"ec2:CreateRoute",
			"ec2:ModifySubnetAttribute",
			"ec2:ReplaceRoute",
			"kms:EnableKeyRotation",
			"kms:PutKeyPolicy",
			"kms:TagResource",
		],
		resourcePatterns: ["*"],
		conditions: {
			StringEquals: {
				"aws:ResourceTag/Application": ["mymemo-agentcore-canary"],
			},
		},
	},
	ManageCanaryKeyAliasOnly: {
		actions: ["kms:CreateAlias"],
		resourcePatterns: [
			regionalArn("kms", `alias/${CLASSIFIER_RESOURCE_PREFIX}`),
			regionalArn("kms", "key/*"),
		],
		conditions: {
			StringEquals: {
				"kms:RequestAlias": [`alias/${CLASSIFIER_RESOURCE_PREFIX}`],
			},
		},
	},
	InspectRequiredSecretMetadataOnly: {
		actions: ["secretsmanager:ListSecretVersionIds"],
		resourcePatterns: Array.from(
			{ length: 5 },
			() =>
				new RegExp(
					`^arn:aws:secretsmanager:${CLASSIFIER_REGION}:${CLASSIFIER_ACCOUNT_ID}:secret:[A-Za-z0-9/_+=.@-]+$`,
				),
		),
	},
	ManageCanaryRolesOnly: {
		actions: [
			"iam:CreateRole",
			"iam:DeleteRolePolicy",
			"iam:PutRolePolicy",
			"iam:TagRole",
		],
		resourcePatterns: [
			canaryRoleArn("consumer"),
			canaryRoleArn("control"),
			canaryRoleArn("fault-injection"),
			canaryRoleArn("preflight"),
			canaryRoleArn("publisher"),
			canaryRoleArn("runtime"),
			canaryRoleArn("task"),
		],
	},
};

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

function stringValues(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value as string[];
	}
	return undefined;
}

function sameStrings(value: unknown, expected: string[]): boolean {
	const actual = stringValues(value);
	return (
		actual !== undefined &&
		actual.length === expected.length &&
		actual.slice().sort().join("\0") === expected.slice().sort().join("\0")
	);
}

function matchesResourcePatterns(
	value: unknown,
	patterns: (string | RegExp)[],
): boolean {
	const resources = stringValues(value);
	if (
		!resources ||
		resources.length !== patterns.length ||
		new Set(resources).size !== resources.length
	) {
		return false;
	}
	const unmatched = [...resources];
	for (const pattern of patterns) {
		const index = unmatched.findIndex((resource) =>
			typeof pattern === "string"
				? resource === pattern
				: pattern.test(resource),
		);
		if (index < 0) return false;
		unmatched.splice(index, 1);
	}
	return unmatched.length === 0;
}

function approvedConditions(
	value: unknown,
	expected: PolicyRule["conditions"],
): boolean {
	if (!expected) return value === undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const condition = value as Record<string, unknown>;
	if (!exactObjectKeys(condition, Object.keys(expected))) return false;
	for (const [operatorName, expectedEntries] of Object.entries(expected)) {
		const operator = condition[operatorName];
		if (!operator || typeof operator !== "object" || Array.isArray(operator)) {
			return false;
		}
		const entries = operator as Record<string, unknown>;
		if (!exactObjectKeys(entries, Object.keys(expectedEntries))) return false;
		for (const [key, expectedValues] of Object.entries(expectedEntries)) {
			if (!matchesResourcePatterns(entries[key], expectedValues)) return false;
		}
	}
	return true;
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

function approvedDeploymentPolicy(value: unknown): boolean {
	const policy = parsePolicy(value);
	if (!policy || !exactObjectKeys(policy, ["Statement", "Version"])) {
		return false;
	}
	if (policy.Version !== "2012-10-17" || !Array.isArray(policy.Statement)) {
		return false;
	}
	const seen = new Set<string>();
	for (const value of policy.Statement) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return false;
		const statement = value as Record<string, unknown>;
		const sid = singleStringValue(statement.Sid);
		const rule = sid ? DEPLOYMENT_POLICY_RULES[sid] : undefined;
		if (!sid || !rule || seen.has(sid)) return false;
		const expectedKeys = rule.conditions
			? ["Action", "Condition", "Effect", "Resource", "Sid"]
			: ["Action", "Effect", "Resource", "Sid"];
		if (
			!exactObjectKeys(statement, expectedKeys) ||
			statement.Effect !== "Allow" ||
			!sameStrings(statement.Action, rule.actions) ||
			!matchesResourcePatterns(statement.Resource, rule.resourcePatterns) ||
			!approvedConditions(statement.Condition, rule.conditions)
		) {
			return false;
		}
		seen.add(sid);
	}
	return seen.size === Object.keys(DEPLOYMENT_POLICY_RULES).length;
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
			singleStringValue(trust.Action) === "sts:AssumeRole" &&
			exactObjectKeys(principalRecord, ["Service"]) &&
			singleStringValue(principalRecord.Service) === "lambda.amazonaws.com"
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
		const arnLike = conditionRecord.ArnLike;
		if (!arnLike || typeof arnLike !== "object" || Array.isArray(arnLike)) {
			return false;
		}
		const arnLikeRecord = arnLike as Record<string, unknown>;
		return (
			exactObjectKeys(trust, ["Action", "Condition", "Effect", "Principal"]) &&
			singleStringValue(trust.Action) === "sts:AssumeRole" &&
			exactObjectKeys(principalRecord, ["Service"]) &&
			singleStringValue(principalRecord.Service) === "states.amazonaws.com" &&
			exactObjectKeys(conditionRecord, ["ArnLike", "StringEquals"]) &&
			exactObjectKeys(equalsRecord, ["aws:SourceAccount"]) &&
			singleStringValue(equalsRecord["aws:SourceAccount"]) ===
				CLASSIFIER_ACCOUNT_ID &&
			exactObjectKeys(arnLikeRecord, ["aws:SourceArn"]) &&
			singleStringValue(arnLikeRecord["aws:SourceArn"]) ===
				CANARY_STATE_MACHINE_ARN_PATTERN
		);
	}

	if (address === "aws_iam_role.runtime") {
		const arnLike = conditionRecord.ArnLike;
		if (!arnLike || typeof arnLike !== "object" || Array.isArray(arnLike))
			return false;
		const arnLikeRecord = arnLike as Record<string, unknown>;
		return (
			exactObjectKeys(trust, ["Action", "Condition", "Effect", "Principal"]) &&
			singleStringValue(trust.Action) === "sts:AssumeRole" &&
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

	if (GITHUB_ROLE_ADDRESSES.has(address)) {
		return (
			exactObjectKeys(trust, ["Action", "Condition", "Effect", "Principal"]) &&
			singleStringValue(trust.Action) === "sts:AssumeRoleWithWebIdentity" &&
			exactObjectKeys(principalRecord, ["Federated"]) &&
			singleStringValue(principalRecord.Federated) ===
				iamArn("oidc-provider/token.actions.githubusercontent.com") &&
			exactObjectKeys(conditionRecord, ["StringEquals"]) &&
			exactObjectKeys(equalsRecord, [
				"token.actions.githubusercontent.com:aud",
				"token.actions.githubusercontent.com:sub",
			]) &&
			singleStringValue(
				equalsRecord["token.actions.githubusercontent.com:aud"],
			) === "sts.amazonaws.com" &&
			singleStringValue(
				equalsRecord["token.actions.githubusercontent.com:sub"],
			) === "repo:X-GPT/mymemo-agent:ref:refs/heads/main"
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
		if (
			type === "aws_iam_role_policy" &&
			resourceBaseAddress(address) === DEPLOYMENT_ROLE_POLICY_ADDRESS &&
			(actions.includes("create") || actions.includes("update")) &&
			!approvedDeploymentPolicy(resource.change?.after?.policy)
		) {
			reasons.push(`${address} has unapproved GitHub role permissions`);
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
