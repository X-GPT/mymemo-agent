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
	routeNetworkInterfaceId?: string;
	asgHealth?: string;
	asgAvailabilityZone?: string;
	networkInterfaceSourceDestCheck?: boolean;
	networkInterfaceSubnetId?: string;
	addressInstanceId?: string;
	instanceState?: string;
	instanceAmiId?: string;
	httpTokens?: string;
	deleteOnTermination?: boolean;
	volumeEncrypted?: boolean;
}) {
	const privateSubnetId = "subnet-private-a";
	const publicSubnetId = "subnet-public-a";
	const routeTableId = "rtb-private-a";
	const networkInterfaceId = "eni-a";
	const eipAllocationId = "eipalloc-a";
	const autoscalingGroupName = "fck-nat-a";
	const availabilityZone = "us-west-2a";
	const instanceId = "i-a";
	const amiId = "ami-a";
	const volumeId = "vol-a";
	const routeTable = {
		RouteTables: [
			{
				RouteTableId: routeTableId,
				Associations: [{ SubnetId: privateSubnetId }],
				Routes: [
					{
						DestinationCidrBlock: "0.0.0.0/0",
						NetworkInterfaceId:
							options.routeNetworkInterfaceId ?? networkInterfaceId,
						State: options.routeState ?? "active",
					},
				],
			},
		],
	};
	const autoscalingGroup = {
		AutoScalingGroups: [
			{
				AutoScalingGroupName: autoscalingGroupName,
				MinSize: 1,
				MaxSize: 1,
				DesiredCapacity: 1,
				Instances: [
					{
						InstanceId: instanceId,
						AvailabilityZone: options.asgAvailabilityZone ?? availabilityZone,
						LifecycleState: "InService",
						HealthStatus: options.asgHealth ?? "Healthy",
					},
				],
			},
		],
	};
	const networkInterface = {
		NetworkInterfaces: [
			{
				NetworkInterfaceId: networkInterfaceId,
				SubnetId: options.networkInterfaceSubnetId ?? publicSubnetId,
				Status: "in-use",
				SourceDestCheck: options.networkInterfaceSourceDestCheck ?? false,
				Attachment: { InstanceId: instanceId },
			},
		],
	};
	const address = {
		Addresses: [
			{
				AllocationId: eipAllocationId,
				AssociationId: "eipassoc-a",
				InstanceId: options.addressInstanceId ?? instanceId,
				PublicIp: "203.0.113.1",
			},
		],
	};
	const instance = {
		Reservations: [
			{
				Instances: [
					{
						InstanceId: instanceId,
						SubnetId: publicSubnetId,
						Placement: { AvailabilityZone: availabilityZone },
						ImageId: options.instanceAmiId ?? amiId,
						State: { Name: options.instanceState ?? "running" },
						MetadataOptions: { HttpTokens: options.httpTokens ?? "required" },
						BlockDeviceMappings: [
							{
								Ebs: {
									VolumeId: volumeId,
									DeleteOnTermination: options.deleteOnTermination ?? true,
								},
							},
						],
					},
				],
			},
		],
	};
	const volume = {
		Volumes: [
			{ VolumeId: volumeId, Encrypted: options.volumeEncrypted ?? true },
		],
	};
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"ec2 describe-route-tables"*) printf '%s\\n' "$ROUTE_TABLE" ;;
    *"autoscaling describe-auto-scaling-groups"*) printf '%s\\n' "$AUTO_SCALING_GROUP" ;;
    *"ec2 describe-network-interfaces"*) printf '%s\\n' "$NETWORK_INTERFACE" ;;
    *"ec2 describe-addresses"*) printf '%s\\n' "$ADDRESS" ;;
    *"ec2 describe-instances"*) printf '%s\\n' "$INSTANCE" ;;
    *"ec2 describe-volumes"*) printf '%s\\n' "$VOLUME" ;;
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
							availability_zone: availabilityZone,
							private_subnet_id: privateSubnetId,
							public_subnet_id: publicSubnetId,
							route_table_id: routeTableId,
							network_interface_id: networkInterfaceId,
							eip_allocation_id: eipAllocationId,
							autoscaling_group_name: autoscalingGroupName,
							ami_id: amiId,
						},
					},
				},
			}),
			ROUTE_TABLE: JSON.stringify(routeTable),
			AUTO_SCALING_GROUP: JSON.stringify(autoscalingGroup),
			NETWORK_INTERFACE: JSON.stringify(networkInterface),
			ADDRESS: JSON.stringify(address),
			INSTANCE: JSON.stringify(instance),
			VOLUME: JSON.stringify(volume),
		},
	});
}

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
	it("accepts a healthy zonal fck-nat route", () => {
		const result = verifyEgress({});
		expect(result.status, result.stderr).toBe(0);
	});

	it.each([
		["inactive route", { routeState: "blackhole" }],
		["foreign route target", { routeNetworkInterfaceId: "eni-foreign" }],
		["unhealthy instance", { asgHealth: "Unhealthy" }],
		["cross-AZ instance", { asgAvailabilityZone: "us-west-2b" }],
		[
			"enabled source/destination checks",
			{ networkInterfaceSourceDestCheck: true },
		],
		["foreign public subnet", { networkInterfaceSubnetId: "subnet-foreign" }],
		["unattached EIP", { addressInstanceId: "i-foreign" }],
		["stopped instance", { instanceState: "stopped" }],
		["unreviewed AMI", { instanceAmiId: "ami-foreign" }],
		["optional IMDSv2", { httpTokens: "optional" }],
		["persistent root disk", { deleteOnTermination: false }],
		["unencrypted root disk", { volumeEncrypted: false }],
	] as const)("rejects %s", (_name, options) => {
		expect(verifyEgress(options).status).not.toBe(0);
	});
});
