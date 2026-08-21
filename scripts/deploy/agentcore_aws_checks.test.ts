import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const checksPath = join(import.meta.dir, "agentcore_aws_checks.sh");
const queueArn =
	"arn:aws:sqs:us-west-2:637423444544:mymemo-agent-agentcore-prod-dispatch";
const consumerArn =
	"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-prod-consumer";
const runtimeArn =
	"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/mymemo_agentcore_prod-runtime";
const endpointArn = `${runtimeArn}/runtime-endpoint/DEFAULT`;
const consumerRoleArn =
	"arn:aws:iam::637423444544:role/mymemo-agent-agentcore-prod-consumer";

const terraformOutput = JSON.stringify({
	consumer_event_source_mapping_uuid: { value: "mapping-1" },
	dispatch_queue_arn: { value: queueArn },
	consumer_function_arn: { value: consumerArn },
	dispatch_enabled_parameter_name: {
		value: "/mymemo/agentcore-dispatch/prod/enabled",
	},
});

interface AlarmConfiguration {
	namespace: string;
	metric_name: string;
	dimensions: Record<string, string>;
	statistic: string;
	period: number;
	evaluation_periods: number;
	datapoints_to_alarm: number;
	comparison_operator: string;
	threshold: number;
	treat_missing_data: string;
	actions_enabled: boolean;
	alarm_actions: string[];
}

const alarmConfigurations: Record<string, AlarmConfiguration> = {
	"mymemo-agent-agentcore-prod-pending-publication-age": {
		namespace: "MyMemo/AgentCoreDispatch",
		metric_name: "PendingAgeMs",
		dimensions: {},
		statistic: "Maximum",
		period: 60,
		evaluation_periods: 1,
		datapoints_to_alarm: 0,
		comparison_operator: "GreaterThanOrEqualToThreshold",
		threshold: 60000,
		treat_missing_data: "breaching",
		actions_enabled: true,
		alarm_actions: ["arn:aws:sns:us-west-2:637423444544:production-alerts"],
	},
	"mymemo-agent-agentcore-prod-publisher-errors": {
		namespace: "MyMemo/AgentCoreDispatch",
		metric_name: "PublisherErrors",
		dimensions: {},
		statistic: "Sum",
		period: 60,
		evaluation_periods: 5,
		datapoints_to_alarm: 3,
		comparison_operator: "GreaterThanOrEqualToThreshold",
		threshold: 1,
		treat_missing_data: "notBreaching",
		actions_enabled: true,
		alarm_actions: ["arn:aws:sns:us-west-2:637423444544:production-alerts"],
	},
};

interface LiveWiring {
	mapping: Record<string, unknown>;
	consumer: Record<string, unknown>;
	concurrency: Record<string, unknown>;
}

function expectedWiring(): LiveWiring {
	return {
		mapping: {
			BatchSize: 1,
			State: "Enabled",
			EventSourceArn: queueArn,
			FunctionArn: consumerArn,
			FunctionResponseTypes: ["ReportBatchItemFailures"],
		},
		consumer: { FunctionArn: consumerArn, Timeout: 120 },
		concurrency: {},
	};
}

function verify(
	wiring: LiveWiring,
	options: {
		emptyConcurrencyResponse?: boolean;
		liveDispatchValue?: "enabled" | "disabled";
		expectedDispatchValue?: "enabled" | "disabled";
	} = {},
) {
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"lambda get-event-source-mapping"*) printf '%s\n' "$MAPPING" ;;
    *"lambda get-function-configuration"*) printf '%s\n' "$CONSUMER" ;;
    *"lambda get-function-concurrency"*)
      if [[ "$EMPTY_CONCURRENCY_RESPONSE" != "true" ]]; then
        printf '%s\n' "$CONCURRENCY"
      fi
      ;;
    *"ssm get-parameter"*) printf '%s\n' "$LIVE_DISPATCH_VALUE" ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_dispatch_wiring us-west-2 "$TF_OUTPUT" "$EXPECTED_DISPATCH_VALUE"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: terraformOutput,
			MAPPING: JSON.stringify(wiring.mapping),
			CONSUMER: JSON.stringify(wiring.consumer),
			CONCURRENCY: JSON.stringify(wiring.concurrency),
			EMPTY_CONCURRENCY_RESPONSE: String(
				options.emptyConcurrencyResponse ?? false,
			),
			LIVE_DISPATCH_VALUE: options.liveDispatchValue ?? "disabled",
			EXPECTED_DISPATCH_VALUE: options.expectedDispatchValue ?? "disabled",
		},
	});
}

function verifyConsumerRuntimeAuthority(simulation: Record<string, unknown>) {
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"iam simulate-principal-policy"*) printf '%s\n' "$SIMULATION" ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_consumer_runtime_authority us-west-2 "$TF_OUTPUT"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: JSON.stringify({
				agent_runtime_arn: { value: runtimeArn },
				consumer_role_arn: { value: consumerRoleArn },
			}),
			SIMULATION: JSON.stringify(simulation),
		},
	});
}

function verifyAlarms(liveConfigurations: Record<string, AlarmConfiguration>) {
	const alarms = Object.entries(liveConfigurations).map(
		([AlarmName, configuration]) => ({
			AlarmName,
			Namespace: configuration.namespace,
			MetricName: configuration.metric_name,
			Dimensions: Object.entries(configuration.dimensions).map(
				([Name, Value]) => ({ Name, Value }),
			),
			Statistic: configuration.statistic,
			Period: configuration.period,
			EvaluationPeriods: configuration.evaluation_periods,
			...(configuration.datapoints_to_alarm > 0
				? { DatapointsToAlarm: configuration.datapoints_to_alarm }
				: {}),
			ComparisonOperator: configuration.comparison_operator,
			Threshold: configuration.threshold,
			TreatMissingData: configuration.treat_missing_data,
			ActionsEnabled: configuration.actions_enabled,
			AlarmActions: [...configuration.alarm_actions].reverse(),
		}),
	);
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"cloudwatch describe-alarms"*) printf '%s\\n' "$ALARMS" ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_alarms us-west-2 "$TF_OUTPUT"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: JSON.stringify({
				alarm_configurations: { value: alarmConfigurations },
			}),
			ALARMS: JSON.stringify({ MetricAlarms: alarms }),
		},
	});
}

function verifyEgress(options: {
	routeState?: string;
	routeNatGatewayId?: string;
	natState?: string;
	natSubnetId?: string;
}) {
	const privateSubnetId = "subnet-private-a";
	const publicSubnetId = "subnet-public-a";
	const routeTableId = "rtb-private-a";
	const natGatewayId = "nat-a";
	const routeTable = {
		RouteTables: [
			{
				RouteTableId: routeTableId,
				Associations: [{ SubnetId: privateSubnetId }],
				Routes: [
					{
						DestinationCidrBlock: "0.0.0.0/0",
						NatGatewayId: options.routeNatGatewayId ?? natGatewayId,
						State: options.routeState ?? "active",
					},
				],
			},
		],
	};
	const natGateway = {
		NatGateways: [
			{
				NatGatewayId: natGatewayId,
				State: options.natState ?? "available",
				SubnetId: options.natSubnetId ?? publicSubnetId,
			},
		],
	};
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"ec2 describe-route-tables"*) printf '%s\\n' "$ROUTE_TABLE" ;;
    *"ec2 describe-nat-gateways"*) printf '%s\\n' "$NAT_GATEWAY" ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_egress us-west-2 "$TF_OUTPUT"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: JSON.stringify({
				egress_configurations: {
					value: {
						"us-west-2a": {
							private_subnet_id: privateSubnetId,
							public_subnet_id: publicSubnetId,
							route_table_id: routeTableId,
							nat_gateway_id: natGatewayId,
						},
					},
				},
			}),
			ROUTE_TABLE: JSON.stringify(routeTable),
			NAT_GATEWAY: JSON.stringify(natGateway),
		},
	});
}

function resolveRuntimeRollbackDigest(
	runtimes: Record<string, unknown>[],
	containerUri: string,
	options: { firstDeploy?: boolean; listFails?: boolean } = {},
) {
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"bedrock-agentcore-control list-agent-runtimes"*)
      if [[ "$LIST_FAILS" == "true" ]]; then
        return 42
      fi
      printf '%s\\n' "$RUNTIMES"
      ;;
    *"bedrock-agentcore-control get-agent-runtime"*) printf '%s\\n' "$RUNTIME" ;;
    *) exit 97 ;;
  esac
}
resolve_agentcore_runtime_rollback_digest us-west-2 prod "$FIRST_DEPLOY"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			AWS_PROFILE: "",
			FIRST_DEPLOY: String(options.firstDeploy ?? false),
			LIST_FAILS: String(options.listFails ?? false),
			RUNTIMES: JSON.stringify({ agentRuntimes: runtimes }),
			RUNTIME: JSON.stringify({
				agentRuntimeArtifact: {
					containerConfiguration: { containerUri },
				},
			}),
		},
	});
}

function validateRuntimeRollbackDigest(
	rollbackDigest: string,
	firstDeploy: string,
) {
	const script = `
set -euo pipefail
source "${checksPath}"
validate_agentcore_runtime_rollback_digest "$ROLLBACK_DIGEST" "$FIRST_DEPLOY"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			ROLLBACK_DIGEST: rollbackDigest,
			FIRST_DEPLOY: firstDeploy,
		},
	});
}

function renderRuntimeRollbackDigestJson(
	rollbackDigest: string,
	firstDeploy: string,
) {
	const script = `
set -euo pipefail
source "${checksPath}"
agentcore_runtime_rollback_digest_json "$ROLLBACK_DIGEST" "$FIRST_DEPLOY"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			ROLLBACK_DIGEST: rollbackDigest,
			FIRST_DEPLOY: firstDeploy,
		},
	});
}

describe("production AgentCore Runtime rollback digest", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	const expectedRuntime = {
		agentRuntimeArn:
			"arn:aws:bedrock-agentcore:us-west-2:637423444544:runtime/mymemo_agentcore_prod-runtime",
		agentRuntimeId: "mymemo_agentcore_prod-runtime",
		agentRuntimeName: "mymemo_agentcore_prod",
		agentRuntimeVersion: "1",
		description: "Production Runtime",
		lastUpdatedAt: "2026-08-20T00:00:00Z",
		status: "READY",
	};

	it("reads the current digest from the one exact live Runtime", () => {
		const result = resolveRuntimeRollbackDigest(
			[
				expectedRuntime,
				{
					...expectedRuntime,
					agentRuntimeId: "foreign-runtime",
					agentRuntimeName: "foreign",
				},
			],
			`example.test/mymemo/agentcore-runtime@${digest}`,
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(digest);
	});

	it("allows a first deployment without a rollback target", () => {
		const result = resolveRuntimeRollbackDigest(
			[],
			`example.test/mymemo/agentcore-runtime@${digest}`,
			{ firstDeploy: true },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("rejects an ordinary release without a live Runtime", () => {
		expect(
			resolveRuntimeRollbackDigest(
				[],
				`example.test/mymemo/agentcore-runtime@${digest}`,
			).status,
		).not.toBe(0);
	});

	it("rejects duplicate live Runtimes", () => {
		expect(
			resolveRuntimeRollbackDigest(
				[expectedRuntime, expectedRuntime],
				`example.test/mymemo/agentcore-runtime@${digest}`,
				{ firstDeploy: true },
			).status,
		).not.toBe(0);
	});

	it("fails closed when Runtime discovery fails", () => {
		expect(
			resolveRuntimeRollbackDigest(
				[],
				`example.test/mymemo/agentcore-runtime@${digest}`,
				{ firstDeploy: true, listFails: true },
			).status,
		).not.toBe(0);
	});

	it("rejects a malformed Runtime summary during first deployment", () => {
		expect(
			resolveRuntimeRollbackDigest(
				[{}],
				`example.test/mymemo/agentcore-runtime@${digest}`,
				{ firstDeploy: true },
			).status,
		).not.toBe(0);
	});

	it("rejects a Runtime image without an exact digest", () => {
		expect(
			resolveRuntimeRollbackDigest(
				[expectedRuntime],
				"example.test/mymemo/agentcore-runtime:latest",
			).status,
		).not.toBe(0);
	});
});

describe("production AgentCore Runtime rollback evidence", () => {
	const digest = `sha256:${"b".repeat(64)}`;

	it("accepts an absent rollback target only during first deployment", () => {
		expect(validateRuntimeRollbackDigest("", "true").status).toBe(0);
		expect(validateRuntimeRollbackDigest("", "false").status).not.toBe(0);
	});

	it("rejects malformed first-deploy state and digests", () => {
		expect(validateRuntimeRollbackDigest(digest, "yes").status).not.toBe(0);
		expect(
			validateRuntimeRollbackDigest("sha256:not-a-digest", "false").status,
		).not.toBe(0);
	});

	it("renders absent and existing rollback targets as JSON values", () => {
		const absent = renderRuntimeRollbackDigestJson("", "true");
		const existing = renderRuntimeRollbackDigestJson(digest, "false");

		expect(absent.status, absent.stderr).toBe(0);
		expect(absent.stdout.trim()).toBe("null");
		expect(existing.status, existing.stderr).toBe(0);
		expect(JSON.parse(existing.stdout)).toBe(digest);
	});
});

describe("production AgentCore dispatch wiring", () => {
	it("accepts the enabled consumer while preserving disabled Dispatch", () => {
		const result = verify(expectedWiring());
		expect(result.status, result.stderr).toBe(0);
	});

	it("accepts the enabled consumer while preserving enabled Dispatch", () => {
		const result = verify(expectedWiring(), {
			liveDispatchValue: "enabled",
			expectedDispatchValue: "enabled",
		});
		expect(result.status, result.stderr).toBe(0);
	});

	it("rejects a Dispatch control change during deployment", () => {
		const result = verify(expectedWiring(), {
			liveDispatchValue: "enabled",
			expectedDispatchValue: "disabled",
		});
		expect(result.status).not.toBe(0);
	});

	it("accepts AWS's empty response for unreserved consumer concurrency", () => {
		const result = verify(expectedWiring(), { emptyConcurrencyResponse: true });
		expect(result.status, result.stderr).toBe(0);
	});

	it.each([
		[
			"queue binding",
			(wiring: LiveWiring) => {
				wiring.mapping.EventSourceArn = `${queueArn}-foreign`;
			},
		],
		[
			"consumer binding",
			(wiring: LiveWiring) => {
				wiring.mapping.FunctionArn = `${consumerArn}-foreign`;
			},
		],
		[
			"reserved concurrency",
			(wiring: LiveWiring) => {
				wiring.concurrency.ReservedConcurrentExecutions = 1;
			},
		],
	] as const)("rejects a mismatched %s", (_name, mutate) => {
		const wiring = expectedWiring();
		mutate(wiring);
		expect(verify(wiring).status).not.toBe(0);
	});
});

describe("production AgentCore consumer Runtime authority", () => {
	function allowedSimulation() {
		return {
			EvaluationResults: [
				{
					EvalActionName: "bedrock-agentcore:InvokeAgentRuntime",
					EvalDecision: "allowed",
					ResourceSpecificResults: [
						{
							EvalResourceName: runtimeArn,
							EvalResourceDecision: "allowed",
						},
						{
							EvalResourceName: endpointArn,
							EvalResourceDecision: "allowed",
						},
					],
				},
			],
		};
	}

	it("accepts the IAM simulator's resource-specific allow results", () => {
		const result = verifyConsumerRuntimeAuthority(allowedSimulation());
		expect(result.status, result.stderr).toBe(0);
	});

	it("rejects a denied Runtime resource", () => {
		const simulation = allowedSimulation();
		simulation.EvaluationResults[0].ResourceSpecificResults[0].EvalResourceDecision =
			"implicitDeny";
		expect(verifyConsumerRuntimeAuthority(simulation).status).not.toBe(0);
	});
});

describe("production AgentCore alarm configuration", () => {
	it("accepts the complete Terraform-owned paging invariant, including an omitted AWS datapoints default", () => {
		const result = verifyAlarms(alarmConfigurations);
		expect(result.status, result.stderr).toBe(0);
	});

	it.each([
		[
			"metric namespace",
			"mymemo-agent-agentcore-prod-pending-publication-age",
			"namespace",
			"AWS/Lambda",
		],
		[
			"alarm datapoints",
			"mymemo-agent-agentcore-prod-publisher-errors",
			"datapoints_to_alarm",
			1,
		],
		[
			"alarm action",
			"mymemo-agent-agentcore-prod-publisher-errors",
			"alarm_actions",
			[],
		],
	] as const)("rejects a mismatched %s", (_name, alarmName, field, value) => {
		const configurations = structuredClone(alarmConfigurations);
		Object.assign(configurations[alarmName], { [field]: value });
		expect(verifyAlarms(configurations).status).not.toBe(0);
	});
});

describe("production AgentCore egress configuration", () => {
	it("accepts an active private route through an available NAT", () => {
		const result = verifyEgress({});
		expect(result.status, result.stderr).toBe(0);
	});

	it.each([
		["inactive route", { routeState: "blackhole" }],
		["foreign route target", { routeNatGatewayId: "nat-foreign" }],
		["unavailable NAT", { natState: "failed" }],
		["foreign public subnet", { natSubnetId: "subnet-foreign" }],
	] as const)("rejects %s", (_name, options) => {
		expect(verifyEgress(options).status).not.toBe(0);
	});
});
