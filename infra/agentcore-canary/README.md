# Dormant production AgentCore canary

This state is intentionally independent from the ordinary MyMemo production
and Fargate states. It owns only the AgentCore canary boundary. The remote state
in `shared.tf` is a read-only input; this state must never import shared
VPC, database, Redis, artifact-bucket, ECS, load-balancer, or routing resources.

## Deployment authority

Create GitHub Environments named `production-agentcore-canary` and
`production-agentcore-canary-campaign`, each with at least one required
reviewer. Configure the deployment Environment's non-secret variables
referenced by `agentcore-canary-deploy.yml`. Deployment and campaign-launch
OIDC subjects are bound to the two non-overlapping Environments so one approval
cannot combine code-update and control-invocation authority. The one-time
operator bootstrap script uses the mandatory `mymemo` profile and the same
AWS-6.x canary root, locked state, and fail-closed plan classifier to create only
the immutable ECR repository, the two Environment-assumable canary roles, and
the disabled repair-rule shell. It creates no reusable bootstrap principal. The
narrower deployment role cannot mutate those roles or enable/redefine the
repair schedule; it may attach only the publisher target and publisher-only
EventBridge permission. Rerun the separately controlled operator bootstrap
whenever those bootstrap-owned contracts intentionally change.

Before the first workflow deployment, run this separately controlled one-time
operator command from the reviewed `main` revision:

```bash
scripts/deploy/bootstrap_agentcore_canary.sh bootstrap-mymemo-agentcore-canary-prod
```

It reads the protected Environment's non-secret Terraform inputs through `gh`,
verifies account `637423444544`, builds the Lambda packages, and applies only
the classified bootstrap targets into the dedicated canary state. The GitHub
workflow has no bootstrap path and cannot acquire this authority.

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

Issue #452 installs the preflight capability but deliberately leaves the
deployment dormant: its workflow does not create NAT/EIP or invoke the preflight
Lambda. Issue #453 owns the separately approved network window, two-hour expiry,
preflight orchestration, and verified NAT/EIP cleanup.

During that #453 campaign-network window, `campaign_network_enabled=true` while
`dispatch_enabled=false`. The preflight task sets `ROLLBACK_RUNTIME_IMAGE_DIGEST`
to the retained prior digest and executes:

```bash
AWS_REGION=us-west-2 scripts/deploy/preflight_agentcore_canary.sh
```

The dedicated preflight Lambda has no Run-store or control entrypoint. It reads
only the two exact AWSCURRENT database secrets, requires `sslmode=verify-full`,
loads the bundled RDS CA, and executes `SELECT 1` over certificate-verified TLS.
The wrapper also proves empty queues, secret metadata, alarms, rollback image,
and scoped session-cleanup authority. Issue #453 closes the window through its
separately reviewed cleanup path because the normal deployment classifier
deliberately rejects resource deletion.

`PoisonDispatch` and `DisabledDelivery` are emitted both dimensionlessly for
the #452 alarms and with the bounded `reason` dimension for diagnosis. The
remaining Campaign-deadline, cleanup, lane, NAT-expiry, Reclamation, and
Workspace-taint signals are provisioned dormant here; the #453 orchestrator and
watchdog own emitting them when a Campaign exists.

Turning off dispatch, deleting campaign NAT/EIP, or fully decommissioning this
state cannot roll Fargate or change user routing because those resources do not
exist in this state.
