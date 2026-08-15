# Dormant production AgentCore canary

This state is intentionally independent from the ordinary MyMemo production
and Fargate states. It owns only the AgentCore canary boundary. The remote state
in `shared.tf` is a read-only input; this state must never import shared
VPC, database, Redis, artifact-bucket, ECS, load-balancer, or routing resources.

## Deployment authority

Create a GitHub Environment named `production-agentcore-canary` with at least
one required reviewer and configure its non-secret variables referenced by
`agentcore-canary-deploy.yml`. The OIDC subject is bound exactly to that
Environment. The one-time bootstrap option creates only the immutable ECR
repository and the narrower canary deployment role through the existing
repository deployment role.

Run **Deploy dormant AgentCore canary** manually and enter
`deploy-mymemo-agentcore-canary-prod`. Leaving `runtime_image_digest` empty
builds, checks, and promotes a new Linux ARM64 image. Supplying an existing
digest performs a rollback/promotion without rebuilding it. The immutable ECR
repository retains tagged prior digests, and the deployment artifact records
the prior digest and resolved Runtime version/`DEFAULT` endpoint.

Every normal plan passes through the canary classifier. It rejects deletes,
replacements, unknown modules/resource types, IAM trust changes, and a provider
outside the locked AWS 6.x range. Destruction is a separate, explicit
decommission operation and is never part of this workflow.

## Dormant invariant

Normal deployment fixes both `campaign_network_enabled` and `dispatch_enabled`
to `false`. Post-deploy inspection requires:

- no NAT Gateway or EIP;
- disabled minute repair rule, disabled SQS mapping, and a disabled SSM flag;
- empty queue/DLQ and zero active Runtime sessions;
- ready digest-pinned Runtime and `DEFAULT` endpoint with MMDSv2;
- exact AWSCURRENT secret metadata, scoped invocation IAM, and all alarms.

The inspection performs no Lambda or Runtime invocation and cannot admit a Run.

## Non-Run network preflight

During an independently approved campaign-network window, apply with
`campaign_network_enabled=true` while keeping `dispatch_enabled=false`, set
`ROLLBACK_RUNTIME_IMAGE_DIGEST` to the retained prior digest, and run:

```bash
AWS_REGION=us-west-2 scripts/deploy/preflight_agentcore_canary.sh
```

The dedicated preflight Lambda has no Run-store or control entrypoint. It reads
only the two exact AWSCURRENT database secrets, requires `sslmode=verify-full`,
loads the bundled RDS CA, and executes `SELECT 1` over certificate-verified TLS.
The wrapper also proves empty queues, secret metadata, alarms, rollback image,
and scoped session-cleanup authority. Close the window afterward by applying
`campaign_network_enabled=false`; the plan classifier deliberately rejects the
resulting deletions, so use the separately reviewed campaign cleanup procedure.

Turning off dispatch, deleting campaign NAT/EIP, or fully decommissioning this
state cannot roll Fargate or change user routing because those resources do not
exist in this state.
