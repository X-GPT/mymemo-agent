import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const checksPath = join(import.meta.dir, "agentcore_aws_checks.sh");
function verifyCurrentSecrets(versions: Record<string, unknown>[]) {
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"secretsmanager list-secret-version-ids"*)
      if [[ "$*" == *"--query"* ]]; then exit 96; fi
      printf '%s\n' "$VERSIONS"
      ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_current_secrets us-west-2 "$TF_OUTPUT"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: JSON.stringify({
				runtime_secret_arns: { value: ["arn:secret:database"] },
			}),
			VERSIONS: JSON.stringify({ Versions: versions }),
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

describe("production AgentCore current secrets", () => {
	it("accepts a current version alongside stage-less deprecated versions", () => {
		const result = verifyCurrentSecrets([
			{ VersionId: "deprecated" },
			{ VersionId: "current", VersionStages: ["AWSCURRENT"] },
		]);
		expect(result.status, result.stderr).toBe(0);
	});

	it("rejects a secret without a current version", () => {
		expect(
			verifyCurrentSecrets([
				{ VersionId: "deprecated" },
				{ VersionId: "previous", VersionStages: ["AWSPREVIOUS"] },
			]).status,
		).not.toBe(0);
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
