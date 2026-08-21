# AgentCore rollout and incident operations

This runbook operates the production AgentCore execution runtime, its Dispatch
consumer, and the dedicated Dispatch publisher. It implements the coexistence
boundary in
[ADR-0025](../adr/0025-select-the-execution-runtime-at-conversation-creation.md),
the advisory-locked publication contract in
[ADR-0026](../adr/0026-publish-agentcore-dispatch-through-one-advisory-locked-loop.md),
and the dedicated-service boundary in
[ADR-0027](../adr/0027-deploy-the-agentcore-dispatch-publisher-as-a-dedicated-service.md).
The unified production release state is defined by
[ADR-0028](../adr/0028-unify-production-terraform-state.md), and the production
recovery policy is defined by
[ADR-0029](../adr/0029-recover-production-releases-by-rolling-forward.md).

This runbook treats existing Conversations as disposable only during the first
cutover. Production releases are roll-forward only: contain an incident, ship a
reviewed corrected release, verify it, and restore controls deliberately. This
implements ADR-0029's amendments to ADR-0025 and ADR-0027; no production binary
rollback target is maintained by the release workflow.

Use the `mymemo` AWS profile in `us-west-2`. Run repository deployment commands
only from a clean `main` checkout that matches `origin/main`. Use the
[operator database-access procedure](../../infra/terraform/README.md#operator-database-access)
for every SQL block below; do not copy database credentials into incident notes.

## Control surfaces

A Statsig console search for "runtime" returns two controls with different,
effectively opposite blast radii. Confirm the full name before changing either
one.

| Control | Owner and safe value | Blast radius |
| --- | --- | --- |
| `mymemo_agent_agentcore_runtime_enabled` | Statsig runtime gate; OFF is safe | Evaluated once, after exposure allows Conversation creation. ON stamps a new Conversation `agentcore`; OFF, evaluation failure, or Statsig failure stamps it `fargate`. It does not reroute an existing Conversation, stop its Runs, or halt Dispatch. |
| `mymemo_agent_split_runtime_enabled` | Statsig exposure gate; OFF denies new work | Controls new Conversation creation and new, non-idempotent Run admission. OFF returns `403` instead of falling back to Fargate. Existing-resource reads, reconnect, interruption, and exact Run retries remain available. It never selects an execution runtime. |
| `/mymemo/agentcore-dispatch/prod/enabled` | SSM Dispatch control; only the exact value `enabled` opens it | Fail-closed kill-switch consulted by the publisher and consumer. `disabled`, a missing parameter, an unreadable parameter, or any other value stops delivery for existing AgentCore Conversations. It does not change Conversation stamping. Terraform intentionally ignores value drift. |

Change the SSM control explicitly and verify the read-back:

```sh
agentcore_region=us-west-2
dispatch_parameter=/mymemo/agentcore-dispatch/prod/enabled

aws --profile mymemo --region "$agentcore_region" ssm put-parameter \
  --name "$dispatch_parameter" \
  --type String \
  --value disabled \
  --overwrite
aws --profile mymemo --region "$agentcore_region" ssm get-parameter \
  --name "$dispatch_parameter" \
  --query Parameter.Value \
  --output text
```

Substitute `enabled` only at the enablement step in the rollout below.

## Cutover preconditions

The first cutover is a destructive reset against the current database schema.
The `conversations.execution_runtime` rename is already applied and the retired
canary tables are already gone, so this cutover has no pending incompatible
schema transition. Before starting the reviewed release workflow:

1. Turn both Statsig gates OFF and verify the SSM Dispatch parameter is
   `disabled`.
2. Scale the old chat-api and agent-worker services to zero and wait for them to
   become stable. Keep them at zero until the release workflow starts. Its
   Terraform apply restores the declared desired counts, and its coordinated
   service roll installs the reviewed task definitions.

   ```sh
   cutover_region=us-west-2
   cutover_cluster="$(terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn)"
   cutover_chat_api_service="$(terraform -chdir=infra/terraform output -raw chat_api_service_name)"
   cutover_agent_worker_service="$(terraform -chdir=infra/terraform output -raw agent_worker_service_name)"

   aws --profile mymemo --region "$cutover_region" ecs update-service \
     --cluster "$cutover_cluster" --service "$cutover_chat_api_service" \
     --desired-count 0
   aws --profile mymemo --region "$cutover_region" ecs update-service \
     --cluster "$cutover_cluster" --service "$cutover_agent_worker_service" \
     --desired-count 0
   aws --profile mymemo --region "$cutover_region" ecs wait services-stable \
     --cluster "$cutover_cluster" \
     --services "$cutover_chat_api_service" "$cutover_agent_worker_service"
   ```

3. Delete all old Conversations and Dispatch outbox rows. The deletion does not
   inspect `execution_runtime`. Runs, Run events, and Conversation artifacts
   cascade from `conversations`; the new worker's cleanup sweeps remove retained
   runtime sandboxes, SDK transcripts, and artifact objects after deployment.

   ```sql
   BEGIN;

   LOCK TABLE conversations, runs, agentcore_dispatch_outbox
       IN SHARE ROW EXCLUSIVE MODE;

   WITH deleted_dispatch AS (
       DELETE FROM agentcore_dispatch_outbox
       RETURNING 1
   ), deleted_conversations AS (
       DELETE FROM conversations
       RETURNING 1
   )
   SELECT
       (SELECT count(*) FROM deleted_conversations) AS deleted_conversations,
       (SELECT count(*) FROM deleted_dispatch) AS deleted_dispatch_rows;

   COMMIT;
   ```

4. Take no legacy queue or Runtime-repository action. The production migration
   is complete, and routine deployment no longer contains a legacy migration
   path.

Do not start the release workflow until the destructive database transaction
has committed, both ECS services are at zero, and the SSM parameter still reads
`disabled`.

## Deploy order

The first cutover and ordinary releases are coordinated compatibility events.
The publisher may be paused independently during containment, but every binary
correction ships through a reviewed coordinated release. Schema, envelope,
publisher, consumer, and Runtime versions are not independently releasable.

1. From `main`, manually run **Release deploy** and enter the production
   confirmation phrase. The workflow plans the complete unified state,
   registers only the new migration task definition, runs **Run agent DB
   migrations**, then re-plans and applies ECS, the consumer, and the AgentCore
   Runtime together. It enforces MMDSv2, verifies the Runtime and `DEFAULT`
   endpoint, and uses `scripts/deploy/roll_ecs_services.sh` to roll chat-api,
   the runtime-aware agent-worker, and the dedicated Dispatch publisher
   together. The previously applied runtime rename and canary-table removal are
   skipped by migration history; do not run a separate manual migration.
   Retain the unified plan and inspection artifact with the release record.
2. With both Statsig gates OFF and SSM still `disabled`, confirm the release
   workflow succeeded and all three ECS services are stable. The publisher must
   have desired count one. Agent-worker remains the global expiration and
   Reclamation runner for both runtimes.
3. Set `/mymemo/agentcore-dispatch/prod/enabled` to `enabled`. Confirm the
   publisher emits `PendingAgeMs: 0` when idle and the consumer event-source
   mapping remains enabled.
4. In Statsig, target only the synthetic smoke identity in both the exposure
   gate and `mymemo_agent_agentcore_runtime_enabled`. Leave the runtime gate's
   default OFF. From the VPC-reachable environment, run the ordinary
   public-contract smoke through its deployed wrapper, which pins
   `AGENT_SMOKE_EXPECT_EXECUTION_RUNTIME=agentcore`:

   ```sh
   AGENT_SMOKE_SUITE=core scripts/deploy/prod_smoke.sh
   ```

   The smoke exits nonzero before Run admission unless the public Conversation
   creation response reports `executionRuntime: "agentcore"`. A pass then proves
   done Outcomes, durable history, and Downloadable-artifact listing and
   download for that ordinary Conversation through chat-api; it uses no database
   or queue access. Retain the printed Conversation and Run ids for correlation
   with Runtime telemetry. This pass licenses step 5's staged runtime-gate
   rollout, but does not license setting the default ON or skipping the telemetry
   checks at each stage.
5. Roll out `mymemo_agent_agentcore_runtime_enabled` in deliberate Statsig
   stages. At every stage observe pending age, sustained publisher errors,
   queue/DLQ depth, AgentCore Outcomes, and Fargate health before increasing the
   cohort. Existing Conversations never move when the percentage changes.

Do not enable SSM or widen the runtime gate merely because the deploy commands
returned successfully; the deployment inspection and targeted smoke are
separate gates.

After the first cutover, routine **Release deploy** runs preserve the exact SSM
Dispatch value they observe at startup. They accept either `enabled` or
`disabled`, never toggle the control, and do not require empty queues. Changing
the SSM value remains a separate operator action for rollout and incident
containment.

## Publisher operations

Production has one ECS service named by the Terraform output
`agentcore_dispatch_publisher_service_name` and configured with desired count
one in steady state. ECS may temporarily run the old and new tasks together
during a rolling deployment. This overlap is expected: every task attempts the
same tick-scoped Postgres advisory lock, and only the holder enters the
publication critical section.

The losing task emits `outcome = lock_not_acquired` and
`PublisherLockNotAcquired = 1`. That is informational telemetry, not an error,
lost-lock signal, or paging condition. The lock belongs to one database
connection, not to an ECS task lease. Postgres releases it when that backend
connection ends, including task death, forced replacement, and process crash;
there is no lock expiry to clear manually.

Inspect the service without relying on its literal name:

```sh
agentcore_region=us-west-2
publisher_cluster="$(terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn)"
publisher_service="$(terraform -chdir=infra/terraform output -raw agentcore_dispatch_publisher_service_name)"

aws --profile mymemo --region "$agentcore_region" ecs describe-services \
  --cluster "$publisher_cluster" \
  --services "$publisher_service" \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition,deployments:deployments[*].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount}}'
```

Deliberately setting the service to zero is an operator action, not a normal
steady state. Disable SSM first, then pause and verify it:

```sh
aws --profile mymemo --region "$agentcore_region" ecs update-service \
  --cluster "$publisher_cluster" \
  --service "$publisher_service" \
  --desired-count 0
aws --profile mymemo --region "$agentcore_region" ecs wait services-stable \
  --cluster "$publisher_cluster" \
  --services "$publisher_service"
```

Restore desired count one with the same command after the maintenance action.
A routine Terraform apply also restores the declared count of one. Scaling the
publisher to zero pauses outbox publication only; it does not stop Run admission,
consume already queued envelopes, or take over the SSM kill-switch.

## Incident ladder

`PendingAgeMs` is the primary publisher symptom. It pages at one minute; the
publisher emits zero on every idle lock-owning tick, so missing heartbeat data
also breaches. `PublisherErrors` is secondary and pages only after at least
three failing one-minute periods out of five. `PublisherLockNotAcquired` never
pages and is expected during rolling overlap.

When pending age rises:

1. Confirm the publisher service has a running task and inspect
   `/ecs/mymemo-agent-prod-agentcore-dispatch-publisher` logs for bootstrap
   failure, `reason = tick_failed`, or `reason = ambiguous_send`. Check database,
   SSM, KMS, and SQS reachability. Treat sustained `PublisherErrors` as
   corroborating evidence; do not wait for it before containing an old pending
   row.
2. Set `/mymemo/agentcore-dispatch/prod/enabled` to `disabled` first. This
   removes Dispatch authority for already-existing AgentCore Conversations at
   both publisher and consumer boundaries.
3. Turn `mymemo_agent_agentcore_runtime_enabled` OFF next. This prevents new
   AgentCore Conversations but deliberately leaves existing Conversations on
   their immutable runtime. Do not accidentally turn off
   `mymemo_agent_split_runtime_enabled`: that denies all new agent work rather
   than routing new Conversations to Fargate.
4. Only after both controls are safe, diagnose the incident and prepare a
   corrected coordinated release. Do not select or deploy an older production
   binary as a recovery target.

While SSM is disabled, an admitted Run on an existing AgentCore Conversation
cannot be delivered. It remains `queued`, produces no Assistant response, and
occupies that Conversation's one Active Run slot. The runtime gate cannot help
because the Conversation is already stamped. The runtime-aware Fargate
agent-worker's global queue backstop terminalizes an unowned AgentCore Run with
Outcome `error` after ten minutes of continuous eligibility. The user therefore
sees a delayed `error` Outcome and cannot admit another distinct Run on that
Conversation in the meantime; the system never retries the Run as new work. Do
not wait for this timeout before preparing and deploying the corrected release.

Keep the runtime-aware agent-worker running throughout containment. It remains
the only global queued-Run expiration and Reclamation runner for both `fargate`
and `agentcore` Conversations. The AgentCore Runtime, consumer, and publisher
do not take over that responsibility.

## Containment and corrected release

Production incidents use containment followed by a corrected release; there is
no maintained binary-rollback procedure or rollback image target.

1. Set the SSM Dispatch control to `disabled` and verify the read-back. This
   stops publication and consumption for existing AgentCore Conversations.
2. Turn the Execution runtime gate OFF by setting
   `mymemo_agent_agentcore_runtime_enabled` OFF. This sends newly created
   Conversations to Fargate while preserving the immutable runtime of existing
   Conversations. Turn the exposure gate OFF only when the incident requires
   denying all new agent work.
3. Keep the runtime-aware agent-worker running. It remains the global queued-Run
   expiration and Reclamation runner while AgentCore Dispatch is contained.
4. Diagnose the failure and prepare a reviewed forward fix on `main`. Preserve
   the migrated database schema and do not select a previous container digest,
   task definition, or Runtime version as a release target.
5. Deploy the corrected release with **Release deploy**. The workflow migrates,
   applies the unified production state, rolls all coordinated ECS services,
   verifies the Runtime and `DEFAULT` endpoint, and records the deployed commit
   and immutable Runtime image digest.
6. With SSM still `disabled` and the runtime gate OFF, verify the workflow
   evidence, ECS service stability, Runtime readiness, queue/DLQ state, and
   publisher telemetry. Do not restore controls merely because the apply
   completed.
7. Restore controls deliberately. Set SSM to `enabled` and confirm Dispatch
   health. Target the synthetic smoke identity in the exposure and runtime
   gates, run `AGENT_SMOKE_SUITE=core scripts/deploy/prod_smoke.sh`, and observe
   telemetry. Restore the runtime-gate cohort in stages only after the smoke and
   each telemetry checkpoint pass. If the exposure gate was turned OFF during
   containment, reopen it only after the service is ready for new work.
