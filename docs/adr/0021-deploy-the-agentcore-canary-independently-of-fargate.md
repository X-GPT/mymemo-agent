# Deploy the AgentCore canary independently of Fargate

Status: accepted

The production AgentCore canary will have a dedicated locked Terraform state,
immutable ARM64 image repository, request-oriented Runtime entrypoint, and
operator-run deployment path. The sole canary operator deploys from a clean,
reviewed, current `main` checkout with the mandatory `mymemo` AWS profile and
an explicit typed confirmation. The canary may reference shared production
resources, but applying, disabling, or destroying it must not update the
Fargate service or its state. This preserves Fargate as the unchanged
user-traffic runtime while the drift-prone AgentCore control plane is
evaluated.

The canary keeps its private subnets, route tables, and security group between
campaigns but creates one NAT Gateway and EIP only for an approved campaign
window. AgentCore Runtime compute has no fixed endpoint fee, while a persistent
NAT would dominate the cost of an otherwise on-demand exercise. Delayed
AgentCore-managed ENI release is recorded during cleanup but is not treated as
an application lifecycle feature.

## Considered options

- **Add the canary to the existing production state and image pipeline.**
  Rejected because a canary plan or teardown could then alter user-serving
  Fargate resources, and the existing AMD64 supervisor image does not satisfy
  AgentCore's ARM64 request-runtime contract.
- **Keep NAT provisioned between campaigns.** Rejected because the recurring
  fixed cost is disproportionate to an operator-triggered, traffic-free
  canary.
- **Use a separate database and network.** Rejected because that would avoid
  validating the production ownership, TLS, secret, and recovery wiring the
  canary exists to test.
- **Maintain a GitHub Actions OIDC deployment principal.** Rejected for this
  one-operator verification because it requires a reusable production
  principal, a separate bootstrap authority, and a second statement-level copy
  of the deployment IAM boundary. Those controls are appropriate for a
  recurring autonomous release path, but they do not improve the canary's
  Runtime integration evidence enough to justify their complexity here.

## Consequences

- Canary deployment uses the operator's existing `mymemo` profile from a clean,
  reviewed, current `main` checkout. It creates no reusable GitHub deployment
  principal and has no bootstrap/deployment-role split. The operator path
  records the plan, requires an explicit typed confirmation, and refuses any
  branch or revision other than current `main`.
- Runtime, publisher, consumer, control, and preflight workloads keep separate
  least-privilege roles because they hold materially different production
  capabilities. Campaign-only task and fault-injection roles are not part of
  the dormant deployment; the campaign-orchestration slice owns their
  temporary authority together with the campaign launcher.
- The Runtime reads exact secret ARNs at fresh session boot and requires RDS
  certificate verification without changing Fargate's current TLS behavior.
- The Runtime writes Downloadable objects only below the dedicated
  `objects/agentcore-canary/` prefix. One Terraform local configures both the
  Runtime key generator and its S3 resource ARN so functional access cannot
  widen into the shared production object namespace.
- Every campaign report records the image digest and resolved Runtime version.
- Deployment distinguishes an empty first-deployment state, the repository-only
  zero-digest sentinel, and a previously deployed digest. Backend/output read
  errors fail the deployment instead of being converted into missing rollback
  evidence.
- The control-plane stack remains deployed but disabled between campaigns.
  Campaign cleanup removes Runtime sessions, NAT/EIP, synthetic durable data,
  sandboxes, artifacts, and queued work; full stack destruction is a separate
  decommission operation.
- Runtime image promotion is an explicit operator action from the same clean,
  current `main` checkout and requires typed confirmation. Ordinary Fargate
  releases do not update the dormant AgentCore Runtime.
- Every deployment parses its Terraform plan and permits mutations only inside
  the dedicated canary-resource allowlist. The classifier rejects shared
  production mutation, provider-major changes, replacements, deletions, and
  ordinary-stack decommission, but it does not duplicate the complete IAM
  statement graph. Terraform remains the single representation of workload
  permissions; focused tests verify only security-critical functional
  boundaries such as exact secrets, artifact prefixes, VPC confinement, and
  disabled dispatch.
- Dormant inspection validates connected capabilities rather than isolated
  resource existence: the queue must feed the declared consumer, and the repair
  rule must target the declared publisher through an exact EventBridge-scoped
  Lambda permission. Expected ARNs come from Terraform outputs and are compared
  with the complete live wiring before dormancy is accepted.
