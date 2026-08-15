# Deploy the AgentCore canary independently of Fargate

Status: accepted

The production AgentCore canary will have a dedicated locked Terraform state,
immutable ARM64 image repository, request-oriented Runtime entrypoint, and
deployment role. It may reference shared production resources, but applying,
disabling, or destroying the canary must not update the Fargate service or its
state. This preserves Fargate as the unchanged user-traffic runtime while the
drift-prone AgentCore control plane is evaluated.

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

## Consequences

- Canary deployment and campaign launch use distinct GitHub OIDC roles whose
  trust is restricted to this repository's exact `main`-branch subject; runtime
  fault injection has a narrower service role and accepts no operator-supplied
  resource identifiers.
- The Runtime reads exact secret ARNs at fresh session boot and requires RDS
  certificate verification without changing Fargate's current TLS behavior.
- Every campaign report records the image digest and resolved Runtime version.
- The control-plane stack remains deployed but disabled between campaigns.
  Campaign cleanup removes Runtime sessions, NAT/EIP, synthetic durable data,
  sandboxes, artifacts, and queued work; full stack destruction is a separate
  decommission operation.
- Runtime image promotion is manually dispatched, requires explicit typed
  confirmation, and can assume its AWS role only from `main`. Ordinary Fargate
  releases do not update the dormant AgentCore Runtime.
- Every deployment parses its Terraform plan and permits mutations only inside
  the dedicated canary-resource allowlist. Shared production infrastructure is
  referenced read-only; provider-major changes, replacements, deletions, trust
  expansion, and full decommission require separate explicit approval paths.
