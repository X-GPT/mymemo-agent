# Use zonal fck-nat for AgentCore egress

Status: accepted (2026-08-21).

Production AgentCore private subnets use one fck-nat Auto Scaling group in the
same availability zone instead of an AWS-managed NAT gateway. The dedicated
Dispatch publisher also runs in those private subnets without a public IPv4
address. Each zonal fck-nat deployment has its own static internal ENI and EIP,
so private default routes remain zonal and replacement instances retain stable
route and external-address targets.

The maintained Terraform module and reviewed official ARM64 AMI are pinned.
Terraform keeps ownership of the private routes, creates new EIPs for the
cutover, enables the module's CloudWatch metrics, and alarms when a zonal Auto
Scaling group has no in-service instance. The Runtime and publisher retain
their existing security groups and IAM authority.

## Considered options

- **Keep two managed NAT gateways.** Rejected because their fixed cost is high
  for the expected AgentCore traffic.
- **Use one fck-nat instance for both availability zones.** Rejected because it
  adds a regional single point of failure and cross-zone traffic.
- **Use only AWS service VPC endpoints.** Rejected because the Runtime requires
  general internet egress for OpenRouter and E2B.

## Consequences

- Each availability zone depends on one EC2 instance. Auto Scaling replaces a
  failed instance, but existing connections are lost and egress can be
  unavailable for several minutes while the static ENI and EIP are reattached.
- New EIPs allow the fck-nat instances to become healthy before routes change,
  but the production egress addresses change during the migration.
- The upstream module's static-ENI security group accepts traffic from the VPC
  CIDRs, which matches the supported fck-nat deployment pattern. Only the
  AgentCore private route tables target these ENIs; do not add other subnet
  routes to them without reopening this boundary.
- CloudWatch exposes bandwidth, packet-drop, connection, and allowance metrics;
  the stable Auto Scaling group health alarm pages when no instance is serving,
  and the existing Dispatch pending-age alarm detects workload impact. The
  deployment inspection verifies ENI/EIP attachment and route state, but the
  initial change does not page independently on every published metric.
- A reviewed production plan, post-apply inspection, and a simulated instance
  replacement are required before the migration is considered complete.
