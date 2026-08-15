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
const GITHUB_ROLE_POLICY_ADDRESSES = new Set([
	"aws_iam_role_policy.campaign_launch",
	"aws_iam_role_policy.deployment",
]);

interface PolicyRule {
	actions: string[];
	resourcePatterns: (string | RegExp)[];
	conditions?: Record<string, Record<string, string[]>>;
}

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
			"arn:aws:ecr:us-west-2:637423444544:repository/mymemo/agentcore-canary-runtime",
		],
	},
	ReadCanaryEnablementOnly: {
		actions: ["ssm:GetParameter"],
		resourcePatterns: [
			"arn:aws:ssm:us-west-2:637423444544:parameter/mymemo/agentcore-canary/prod/enabled",
		],
	},
	ManageCanaryRuntimeOnly: {
		actions: [
			"bedrock-agentcore:CreateAgentRuntime",
			"bedrock-agentcore:TagResource",
			"bedrock-agentcore:UpdateAgentRuntime",
		],
		resourcePatterns: [
			"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/mymemo_agentcore_canary_prod-*",
		],
	},
	ManageCanaryAlarmsOnly: {
		actions: [
			"cloudwatch:DeleteAlarms",
			"cloudwatch:PutMetricAlarm",
			"cloudwatch:TagResource",
		],
		resourcePatterns: [
			"arn:aws:cloudwatch:us-west-2:637423444544:alarm:mymemo-agent-agentcore-canary-prod-*",
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
			"arn:aws:ecr:us-west-2:637423444544:repository/mymemo/agentcore-canary-runtime",
		],
	},
	ManageCanaryRepairRuleOnly: {
		actions: ["events:DisableRule"],
		resourcePatterns: [
			"arn:aws:events:us-west-2:637423444544:rule/mymemo-agent-agentcore-canary-prod-repair",
		],
	},
	ManageCanaryRepairTargetOnly: {
		actions: ["events:PutTargets"],
		resourcePatterns: [
			"arn:aws:events:us-west-2:637423444544:rule/mymemo-agent-agentcore-canary-prod-repair",
		],
		conditions: {
			"ForAnyValue:ArnEquals": {
				"events:TargetArn": [
					"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-publisher",
				],
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
		resourcePatterns: [
			"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-*",
		],
	},
	ManageCanaryRepairPermissionOnly: {
		actions: ["lambda:AddPermission"],
		resourcePatterns: [
			"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-publisher",
		],
		conditions: {
			StringEquals: {
				"lambda:Principal": ["events.amazonaws.com"],
			},
		},
	},
	ManageCanaryEventMappingOnly: {
		actions: [
			"lambda:CreateEventSourceMapping",
			"lambda:UpdateEventSourceMapping",
		],
		resourcePatterns: [
			"arn:aws:lambda:us-west-2:637423444544:event-source-mapping:*",
		],
		conditions: {
			ArnLike: {
				"lambda:FunctionArn": [
					"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-consumer",
				],
			},
		},
	},
	ManageCanaryQueuesOnly: {
		actions: ["sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:TagQueue"],
		resourcePatterns: [
			"arn:aws:sqs:us-west-2:637423444544:mymemo-agent-agentcore-canary-prod-*",
		],
	},
	ManageCanaryParameterOnly: {
		actions: ["ssm:AddTagsToResource", "ssm:PutParameter"],
		resourcePatterns: [
			"arn:aws:ssm:us-west-2:637423444544:parameter/mymemo/agentcore-canary/prod/*",
		],
	},
	InspectCanaryRolesOnly: {
		actions: ["iam:SimulatePrincipalPolicy"],
		resourcePatterns: [
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-*",
		],
	},
	PassConsumerRoleOnly: {
		actions: ["iam:PassRole"],
		resourcePatterns: [
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-consumer",
		],
		conditions: {
			ArnEquals: {
				"iam:AssociatedResourceArn": [
					"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-consumer",
				],
			},
			StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com"] },
		},
	},
	PassControlRoleOnly: {
		actions: ["iam:PassRole"],
		resourcePatterns: [
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-control",
		],
		conditions: {
			ArnEquals: {
				"iam:AssociatedResourceArn": [
					"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-control",
				],
			},
			StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com"] },
		},
	},
	PassPreflightRoleOnly: {
		actions: ["iam:PassRole"],
		resourcePatterns: [
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-preflight",
		],
		conditions: {
			ArnEquals: {
				"iam:AssociatedResourceArn": [
					"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-preflight",
				],
			},
			StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com"] },
		},
	},
	PassPublisherRoleOnly: {
		actions: ["iam:PassRole"],
		resourcePatterns: [
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-publisher",
		],
		conditions: {
			ArnEquals: {
				"iam:AssociatedResourceArn": [
					"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-publisher",
				],
			},
			StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com"] },
		},
	},
	PassRuntimeRoleOnly: {
		actions: ["iam:PassRole"],
		resourcePatterns: [
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-runtime",
		],
		conditions: {
			ArnLike: {
				"iam:AssociatedResourceArn": [
					"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/mymemo_agentcore_canary_prod-*",
				],
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
			"arn:aws:kms:us-west-2:637423444544:alias/mymemo-agent-agentcore-canary-prod",
			"arn:aws:kms:us-west-2:637423444544:key/*",
		],
		conditions: {
			StringEquals: {
				"kms:RequestAlias": ["alias/mymemo-agent-agentcore-canary-prod"],
			},
		},
	},
	InspectRequiredSecretMetadataOnly: {
		actions: ["secretsmanager:ListSecretVersionIds"],
		resourcePatterns: Array.from(
			{ length: 5 },
			() =>
				/^arn:aws:secretsmanager:us-west-2:637423444544:secret:[A-Za-z0-9/_+=.@-]+$/,
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
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-consumer",
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-control",
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-fault-injection",
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-preflight",
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-publisher",
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-runtime",
			"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-canary-prod-task",
		],
	},
};

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
			if (!sameStrings(entries[key], expectedValues)) return false;
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
		const sid = oneString(statement.Sid);
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

function approvedCampaignLaunchPolicy(value: unknown): boolean {
	const policy = parsePolicy(value);
	if (
		!policy ||
		!exactObjectKeys(policy, ["Statement", "Version"]) ||
		policy.Version !== "2012-10-17" ||
		!Array.isArray(policy.Statement) ||
		policy.Statement.length !== 1
	) {
		return false;
	}
	const valueStatement = policy.Statement[0];
	if (
		!valueStatement ||
		typeof valueStatement !== "object" ||
		Array.isArray(valueStatement)
	) {
		return false;
	}
	const statement = valueStatement as Record<string, unknown>;
	return (
		exactObjectKeys(statement, ["Action", "Effect", "Resource"]) &&
		statement.Effect === "Allow" &&
		oneString(statement.Action) === "lambda:InvokeFunction" &&
		oneString(statement.Resource) ===
			"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-canary-prod-control"
	);
}

function approvedGithubRolePolicy(address: string, value: unknown): boolean {
	if (address === "aws_iam_role_policy.deployment") {
		return approvedDeploymentPolicy(value);
	}
	if (address === "aws_iam_role_policy.campaign_launch") {
		return approvedCampaignLaunchPolicy(value);
	}
	return false;
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
		const arnLike = conditionRecord.ArnLike;
		if (!arnLike || typeof arnLike !== "object" || Array.isArray(arnLike)) {
			return false;
		}
		const arnLikeRecord = arnLike as Record<string, unknown>;
		const sourceAccount = oneString(equalsRecord["aws:SourceAccount"]) ?? "";
		const sourceArn = oneString(arnLikeRecord["aws:SourceArn"]) ?? "";
		const sourceArnAccount =
			/^arn:aws:states:[a-z0-9-]+:(\d{12}):stateMachine:mymemo-agent-agentcore-canary-prod-\*$/.exec(
				sourceArn,
			)?.[1];
		return (
			exactObjectKeys(trust, ["Action", "Condition", "Effect", "Principal"]) &&
			oneString(trust.Action) === "sts:AssumeRole" &&
			exactObjectKeys(principalRecord, ["Service"]) &&
			oneString(principalRecord.Service) === "states.amazonaws.com" &&
			exactObjectKeys(conditionRecord, ["ArnLike", "StringEquals"]) &&
			exactObjectKeys(equalsRecord, ["aws:SourceAccount"]) &&
			/^\d{12}$/.test(sourceAccount) &&
			exactObjectKeys(arnLikeRecord, ["aws:SourceArn"]) &&
			sourceArnAccount === sourceAccount
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
		const expectedEnvironment =
			address === "aws_iam_role.deployment"
				? "production-agentcore-canary"
				: "production-agentcore-canary-campaign";
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
				`repo:X-GPT/mymemo-agent:environment:${expectedEnvironment}`
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
			GITHUB_ROLE_POLICY_ADDRESSES.has(resourceBaseAddress(address)) &&
			(actions.includes("create") || actions.includes("update")) &&
			!approvedGithubRolePolicy(
				resourceBaseAddress(address),
				resource.change?.after?.policy,
			)
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
