# Dormant production AgentCore canary

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

The dormant state creates no reusable GitHub OIDC deployment principal, campaign
launcher, campaign task role, fault-injection role, or control trigger. Issue
#453 owns the temporary campaign roles and launcher.

Every normal plan passes through the canary classifier. It rejects deletes,
replacements, unknown modules/resource types, workload trust changes, and a
provider outside the locked AWS 6.x range. It intentionally does not duplicate
Terraform's statement-by-statement workload IAM. Destruction is a separate,
explicit decommission operation and is never part of this command.

## Dormant invariant

Normal deployment fixes both `campaign_network_enabled` and `dispatch_enabled`
to `false`. Post-deploy inspection requires:

- no NAT Gateway or EIP;
- disabled minute repair rule, disabled SQS mapping, and a disabled SSM flag;
- exact queue-to-consumer and repair-rule-to-publisher target/permission wiring;
- empty queue/DLQ and zero active Runtime sessions;
- ready digest-pinned Runtime and `DEFAULT` endpoint with MMDSv2;
- exact AWSCURRENT secret metadata, scoped invocation IAM, and all alarms.

The Runtime and its execution role share the Terraform-owned
`objects/agentcore-canary/` object-key prefix. Canary publication therefore
cannot overwrite ordinary production artifacts in the shared bucket.

The inspection performs no Lambda or Runtime invocation and cannot admit a Run.

## Non-Run network preflight

Issue #452 installs the preflight capability but deliberately leaves the
deployment dormant: its operator command does not create NAT/EIP or invoke the
preflight Lambda. Issue #453 owns the temporary network window, two-hour expiry,
preflight orchestration, and verified NAT/EIP cleanup after its operator command
launches the durable Campaign from `main`.

During that #453 campaign-network window, `campaign_network_enabled=true` while
`dispatch_enabled=false`. The preflight task sets `ROLLBACK_RUNTIME_IMAGE_DIGEST`
to the retained prior digest and executes:

```bash
AWS_REGION=us-west-2 scripts/deploy/preflight_agentcore_canary.sh
```

The dedicated preflight Lambda has no Run-store or control entrypoint. It reads
only the two exact AWSCURRENT database secrets, requires `sslmode=verify-full`,
loads the bundled RDS CA, and executes `SELECT 1` over certificate-verified TLS.
The wrapper also revalidates the disabled mapping, repair rule, and SSM flag;
the ready digest-pinned Runtime, MMDSv2, `DEFAULT` endpoint, and consumer
invocation authority; plus empty queues, secret metadata, alarms, rollback
image. Issue #453 verifies cleanup authority and closes the window
through its durable campaign orchestration because the normal deployment
classifier deliberately rejects resource deletion.

`PoisonDispatch` and `DisabledDelivery` are emitted both dimensionlessly for
the #452 alarms and with the bounded `reason` dimension for diagnosis. The
remaining Campaign-deadline, cleanup, lane, NAT-expiry, Reclamation, and
Workspace-taint signals are provisioned dormant here; the #453 orchestrator and
watchdog own emitting them when a Campaign exists.

Turning off dispatch, deleting campaign NAT/EIP, or fully decommissioning this
state cannot roll Fargate or change user routing because those resources do not
exist in this state.
