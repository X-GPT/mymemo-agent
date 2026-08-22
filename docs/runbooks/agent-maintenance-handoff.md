# Agent maintenance ownership handoff

`agent-worker` and `agent-maintenance` must never run global maintenance at the
same time. Terraform rejects a configuration where both desired counts are
nonzero, but one apply that swaps `1/0` directly to `0/1` can still overlap
stopping worker tasks with starting maintenance tasks. Use the two releases
below.

## Before the handoff

1. Disable AgentCore Dispatch in SSM and close agent exposure.
2. Confirm there are zero Active Runs and no live Conversation Ownership.
3. Confirm the release contains the compatible schema and the
   `agent-maintenance` task definition, while
   `agent_maintenance_desired_count = 0`.

## Release A: stop the old owner

Set both counts to zero and run the ordinary reviewed release:

```hcl
agent_worker_desired_count      = 0
agent_maintenance_desired_count = 0
```

Resolve the cluster and worker service through Terraform outputs, then wait for
the worker service to stabilize and verify `desiredCount`, `runningCount`, and
`pendingCount` are all zero. Also use `aws ecs list-tasks` for the worker service
with both `RUNNING` and `PENDING`; both results must be empty. Do not start
maintenance while any old worker task is present.

## Release B: start the sole owner

After Release A is proven stopped, keep the worker at zero, set maintenance to
one, and run the compatible migration/release:

```hcl
agent_worker_desired_count      = 0
agent_maintenance_desired_count = 1
```

Resolve `agent_maintenance_service_name` through Terraform output and wait for
the service to stabilize. Verify one healthy task, a successful
`agent-maintenance started` log in `/ecs/mymemo-agent-prod-maintenance`, and no
new `agent-maintenance-errors` alarm. The task receives only the agent database
password, E2B API key, artifact bucket/region, logging, and health-port settings.
Its task role can only delete artifact objects.

Re-enable Dispatch and exposure only after queued-Run expiration, Reclamation,
and cleanup logs have appeared at their normal cadence and the old worker
service remains at zero.
