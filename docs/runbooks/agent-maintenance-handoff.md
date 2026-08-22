# Fargate retirement handoff

Use this one-time procedure for the release that retires the former Fargate
Run-serving service and makes `agent-maintenance` the sole production owner of
queued-Run expiration, Reclamation, and asynchronous cleanup.

## Quiesce production

1. Close the Statsig exposure gate so no new Conversations or Runs are admitted.
2. Set the AgentCore Dispatch SSM control to `disabled` so no queued Dispatch is
   delivered during the schema and service transition.
3. Confirm Postgres contains zero Active Runs and no live Conversation Ownership.
4. From the pre-retirement checkout, stop the old worker service and wait for
   both `RUNNING` and `PENDING` task counts to reach zero:

   ```bash
   cluster_arn="$(terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn)"
   worker_service="$(terraform -chdir=infra/terraform output -raw agent_worker_service_name)"
   AWS_PROFILE=mymemo aws ecs update-service --region us-west-2 \
     --cluster "${cluster_arn}" --service "${worker_service}" --desired-count 0
   AWS_PROFILE=mymemo aws ecs wait services-stable --region us-west-2 \
     --cluster "${cluster_arn}" --services "${worker_service}"
   AWS_PROFILE=mymemo aws ecs describe-services --region us-west-2 \
     --cluster "${cluster_arn}" --services "${worker_service}" \
     --query 'services[0].{running:runningCount,pending:pendingCount}'
   ```

   Do not apply the retirement migration until the final command reports both
   counts as zero; an old binary must not read the removed queue index,
   doorbell, or deployment-readiness table.

## Apply the retirement release

Run the ordinary reviewed release. Its compatible migration drops the retired
doorbell triggers/function, queue-Claim index, and execution-runtime deployment
table. Terraform removes the worker task/service, ECR repository and images,
IAM, secrets, and alarms, and runs `agent-maintenance` with desired count one.

Wait for the chat-api, Dispatch publisher, and maintenance ECS services to
stabilize. Verify the AgentCore Runtime digest was updated by the same release.

## Prove the new owner before reopening

1. Confirm exactly one healthy maintenance task and no retired worker service or
   task remains.
2. Confirm `maintenance liveness pass complete` and `cleanup pass complete` in
   `/ecs/mymemo-agent-prod-maintenance`.
3. Confirm neither `agent-maintenance-errors` nor
   `agent-maintenance-heartbeat` is alarming.
4. Inspect the production schema and confirm the retired table, index, triggers,
   and function are absent while `conversations.execution_runtime` remains and
   accepts only `agentcore`.
5. Re-enable Dispatch, then reopen exposure. Run the production smoke and verify
   Conversation creation reports `agentcore` and a Run completes through the
   AgentCore Runtime.

If any proof fails, keep Dispatch disabled and exposure closed, roll forward a
fix, and repeat the checks. Do not restore the retired worker binary against the
new schema.
