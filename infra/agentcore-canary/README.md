# Dormant AgentCore dispatch and Runtime

This state is intentionally independent from the ordinary MyMemo production
and Fargate states. It owns only the AgentCore canary boundary. The remote state
in `shared.tf` is a read-only input; this state must never import shared
VPC, database, Redis, artifact-bucket, ECS, load-balancer, or routing resources.

## Deployment authority

Configure the repository's non-secret `AGENTCORE_CANARY_*` variables, then run
the operator deployment from a clean checkout whose `main` exactly matches
`origin/main`. The command uses only the mandatory `mymemo` AWS profile, verifies
account `637423444544`, and requires an explicit production confirmation:

```bash
scripts/deploy/deploy_agentcore_canary.sh deploy-mymemo-agentcore-canary-prod
```

Pass an existing digest as the second argument to promote or roll back without
rebuilding. With no digest, the command builds and verifies a new Linux ARM64
image. The first classified phase creates only the immutable ECR repository so
the image can be pushed; the full classified plan then deploys the dormant
boundary using the same operator session. This is one deployment path, not a
separate bootstrap authority. Plan JSON/text, the prior digest, resolved Runtime
version, and dormant inspection are retained under
`dist/agentcore-canary-deployment/`.

The dormant state creates no reusable GitHub OIDC deployment principal or
operator-only Run-admission path.

Every normal plan passes through the canary classifier. It rejects replacements,
unknown modules/resource types, workload trust changes, and a provider outside
the locked AWS 6.x range. Deletions are rejected except for the exact retired
control/preflight, campaign-network, and campaign-alarm resources removed by
issue #477. It intentionally does not duplicate Terraform's
statement-by-statement workload IAM.

## Dormant invariant

Normal deployment fixes `dispatch_enabled` to `false`. Post-deploy inspection
requires:

- disabled minute repair rule, disabled SQS mapping, and a disabled SSM flag;
- exact queue-to-consumer and repair-rule-to-publisher target/permission wiring;
- empty queue/DLQ;
- ready digest-pinned Runtime and `DEFAULT` endpoint with MMDSv2;
- exact AWSCURRENT secret metadata, scoped invocation IAM, and dispatch alarms.

The Runtime publishes Downloadable artifacts through the same standard
`objects/` namespace as Fargate. Object identities remain UUID-based, and the
Runtime execution role is scoped to that namespace in the shared bucket.

The inspection performs no Lambda or Runtime invocation and cannot admit a Run.

Turning off dispatch or fully decommissioning this state cannot roll Fargate or
change user routing because those resources do not exist in this state.
