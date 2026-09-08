#!/usr/bin/env bash

agentcore_aws() {
  if [[ -n "${AWS_PROFILE:-}" ]]; then
    aws --profile "${AWS_PROFILE}" "$@"
  else
    aws "$@"
  fi
}

verify_agentcore_current_secrets() {
  local region="$1"
  local terraform_output="$2"
  local secret_arn

  while IFS= read -r secret_arn; do
    agentcore_aws secretsmanager list-secret-version-ids \
      --region "${region}" \
      --secret-id "${secret_arn}" \
      --include-deprecated \
      --output json \
      | jq -e 'any(.Versions[]?; ((.VersionStages // []) | index("AWSCURRENT")) != null)' >/dev/null
  done < <(jq -r '.runtime_secret_arns.value[]' <<<"${terraform_output}")
}


verify_agentcore_egress() {
  local region="$1"
  local terraform_output="$2"
  local configuration
  local private_subnet_id
  local public_subnet_id
  local route_table_id
  local network_interface_id
  local eip_allocation_id
  local autoscaling_group_name
  local availability_zone
  local ami_id
  local instance_id
  local volume_id
  local route_table
  local network_interface
  local address
  local autoscaling_group
  local instance
  local volume

  while IFS= read -r configuration; do
    private_subnet_id="$(jq -r '.private_subnet_id' <<<"${configuration}")"
    public_subnet_id="$(jq -r '.public_subnet_id' <<<"${configuration}")"
    route_table_id="$(jq -r '.route_table_id' <<<"${configuration}")"
    network_interface_id="$(jq -r '.network_interface_id' <<<"${configuration}")"
    eip_allocation_id="$(jq -r '.eip_allocation_id' <<<"${configuration}")"
    autoscaling_group_name="$(jq -r '.autoscaling_group_name' <<<"${configuration}")"
    availability_zone="$(jq -r '.availability_zone' <<<"${configuration}")"
    ami_id="$(jq -r '.ami_id' <<<"${configuration}")"

    route_table="$(agentcore_aws ec2 describe-route-tables \
      --region "${region}" \
      --route-table-ids "${route_table_id}")"
    jq -e \
      --arg routeTableId "${route_table_id}" \
      --arg privateSubnetId "${private_subnet_id}" \
      --arg networkInterfaceId "${network_interface_id}" \
      '.RouteTables
        | length == 1
          and .[0].RouteTableId == $routeTableId
          and any(.[0].Associations[]?; .SubnetId == $privateSubnetId)
          and any(.[0].Routes[]?;
            .DestinationCidrBlock == "0.0.0.0/0"
            and .NetworkInterfaceId == $networkInterfaceId
            and .State == "active")' \
      <<<"${route_table}" >/dev/null

    autoscaling_group="$(agentcore_aws autoscaling describe-auto-scaling-groups \
      --region "${region}" \
      --auto-scaling-group-names "${autoscaling_group_name}")"
    jq -e \
      --arg autoscalingGroupName "${autoscaling_group_name}" \
      --arg availabilityZone "${availability_zone}" \
      '.AutoScalingGroups
        | length == 1
          and .[0].AutoScalingGroupName == $autoscalingGroupName
          and .[0].MinSize == 1
          and .[0].MaxSize == 1
          and .[0].DesiredCapacity == 1
          and (.[0].Instances | length == 1)
          and .[0].Instances[0].AvailabilityZone == $availabilityZone
          and .[0].Instances[0].LifecycleState == "InService"
          and .[0].Instances[0].HealthStatus == "Healthy"' \
      <<<"${autoscaling_group}" >/dev/null
    instance_id="$(jq -r '.AutoScalingGroups[0].Instances[0].InstanceId' <<<"${autoscaling_group}")"

    network_interface="$(agentcore_aws ec2 describe-network-interfaces \
      --region "${region}" \
      --network-interface-ids "${network_interface_id}")"
    jq -e \
      --arg networkInterfaceId "${network_interface_id}" \
      --arg publicSubnetId "${public_subnet_id}" \
      --arg instanceId "${instance_id}" \
      '.NetworkInterfaces
        | length == 1
          and .[0].NetworkInterfaceId == $networkInterfaceId
          and .[0].SubnetId == $publicSubnetId
          and .[0].Status == "in-use"
          and .[0].SourceDestCheck == false
          and .[0].Attachment.InstanceId == $instanceId' \
      <<<"${network_interface}" >/dev/null

    address="$(agentcore_aws ec2 describe-addresses \
      --region "${region}" \
      --allocation-ids "${eip_allocation_id}")"
    jq -e \
      --arg eipAllocationId "${eip_allocation_id}" \
      --arg instanceId "${instance_id}" \
      '.Addresses
        | length == 1
          and .[0].AllocationId == $eipAllocationId
          and .[0].InstanceId == $instanceId
          and (.[0].AssociationId | strings | length > 0)
          and (.[0].PublicIp | strings | length > 0)' \
      <<<"${address}" >/dev/null

    instance="$(agentcore_aws ec2 describe-instances \
      --region "${region}" \
      --instance-ids "${instance_id}")"
    jq -e \
      --arg instanceId "${instance_id}" \
      --arg publicSubnetId "${public_subnet_id}" \
      --arg availabilityZone "${availability_zone}" \
      --arg amiId "${ami_id}" \
      '.Reservations
        | length == 1
          and (.[0].Instances | length == 1)
          and .[0].Instances[0].InstanceId == $instanceId
          and .[0].Instances[0].SubnetId == $publicSubnetId
          and .[0].Instances[0].Placement.AvailabilityZone == $availabilityZone
          and .[0].Instances[0].ImageId == $amiId
          and .[0].Instances[0].State.Name == "running"
          and .[0].Instances[0].MetadataOptions.HttpTokens == "required"
          and (.[0].Instances[0].BlockDeviceMappings | length == 1)
          and .[0].Instances[0].BlockDeviceMappings[0].Ebs.DeleteOnTermination == true' \
      <<<"${instance}" >/dev/null
    volume_id="$(jq -r '.Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' <<<"${instance}")"

    volume="$(agentcore_aws ec2 describe-volumes \
      --region "${region}" \
      --volume-ids "${volume_id}")"
    jq -e \
      --arg volumeId "${volume_id}" \
      '.Volumes | length == 1 and .[0].VolumeId == $volumeId and .[0].Encrypted == true' \
      <<<"${volume}" >/dev/null
  done < <(jq -c '.egress_configurations.value | to_entries[].value' <<<"${terraform_output}")
}


verify_agentcore_runtime_configuration() {
  local region="$1"
  local terraform_output="$2"
  local expected_digest="$3"
  local runtime_id
  local expected_security_configuration
  local runtime
  local runtime_version
  local endpoint

  runtime_id="$(jq -r '.agent_runtime_id.value' <<<"${terraform_output}")"
  expected_security_configuration="$(jq -c '.runtime_security_configuration.value' <<<"${terraform_output}")"
  runtime="$(agentcore_aws bedrock-agentcore-control get-agent-runtime \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}")"
  jq -e \
    --arg digest "${expected_digest}" \
    --argjson expected "${expected_security_configuration}" \
    '.status == "READY"
      and .roleArn == $expected.role_arn
      and .environmentVariables == $expected.environment_variables
      and .metadataConfiguration.requireMMDSV2 == true
      and .networkConfiguration.networkMode == $expected.network_mode
      and ($expected.network_mode != "VPC" or (
        (.networkConfiguration.networkModeConfig.subnets | sort) == $expected.subnet_ids
        and (.networkConfiguration.networkModeConfig.securityGroups | sort) == $expected.security_group_ids
      ))
      and .protocolConfiguration.serverProtocol == "HTTP"
      and (.agentRuntimeArtifact.containerConfiguration.containerUri | endswith("@" + $digest))
      and .lifecycleConfiguration.idleRuntimeSessionTimeout == $expected.idle_runtime_session_timeout
      and .lifecycleConfiguration.maxLifetime == 3600' \
    <<<"${runtime}" >/dev/null
  runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
  endpoint="$(agentcore_aws bedrock-agentcore-control get-agent-runtime-endpoint \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}" \
    --endpoint-name DEFAULT)"
  jq -e --arg version "${runtime_version}" '.name == "DEFAULT" and .status == "READY" and .liveVersion == $version' <<<"${endpoint}" >/dev/null

  jq -n --arg runtime "${runtime}" --arg endpoint "${endpoint}" \
    '{runtime:($runtime | fromjson), endpoint:($endpoint | fromjson)}'
}
