# Fargate retirement handoff

Use this one-time procedure for the release that retires the former Fargate
Run-serving service and makes `agent-maintenance` the sole production owner of
queued-Run expiration, Reclamation, and asynchronous cleanup.

## Quiesce production

1. Close the Statsig exposure gate so no new Conversations or Runs are admitted.
2. Set the AgentCore Dispatch SSM control to `disabled` so no queued Dispatch is
   delivered during the schema and service transition.
3. Confirm Postgres contains zero Active Runs and no live Conversation Ownership.
4. From the pre-retirement checkout, stop the old worker service and wait until
   every task reaches the `STOPPED` lifecycle state:

   ```bash
   (
     set -euo pipefail

     cluster_arn="$(AWS_PROFILE=mymemo terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn)"
     worker_service="$(AWS_PROFILE=mymemo terraform -chdir=infra/terraform output -raw agent_worker_service_name)"
     AWS_PROFILE=mymemo aws ecs update-service --region us-west-2 \
       --cluster "${cluster_arn}" --service "${worker_service}" --desired-count 0
     AWS_PROFILE=mymemo aws ecs wait services-stable --region us-west-2 \
       --cluster "${cluster_arn}" --services "${worker_service}"

     running_worker_task_arns="$(
       AWS_PROFILE=mymemo aws ecs list-tasks --region us-west-2 \
         --cluster "${cluster_arn}" --service-name "${worker_service}" \
         --desired-status RUNNING --query taskArns --output json
     )"
     stopped_worker_task_arns="$(
       AWS_PROFILE=mymemo aws ecs list-tasks --region us-west-2 \
         --cluster "${cluster_arn}" --service-name "${worker_service}" \
         --desired-status STOPPED --query taskArns --output json
     )"
     worker_task_arns_json="$(
       jq -cn \
         --argjson running "${running_worker_task_arns}" \
         --argjson stopped "${stopped_worker_task_arns}" \
         '$running + $stopped | unique'
     )"
     worker_task_state='{"nonStopped":[],"failures":[]}'
     if (( $(jq 'length' <<<"${worker_task_arns_json}") > 0 )); then
       worker_task_state="$(
         AWS_PROFILE=mymemo aws ecs describe-tasks --region us-west-2 \
           --cluster "${cluster_arn}" \
           --tasks $(jq -r '.[]' <<<"${worker_task_arns_json}") \
           --query '{nonStopped:tasks[?lastStatus!=`STOPPED`].{taskArn:taskArn,lastStatus:lastStatus,desiredStatus:desiredStatus},failures:failures}' \
           --output json
       )"
     fi
     jq . <<<"${worker_task_state}"
     jq -e \
       '(.nonStopped | length) == 0 and (.failures | length) == 0' \
       <<<"${worker_task_state}" >/dev/null
   )
   ```

   Do not apply the retirement migration unless the final JSON contains empty
   `nonStopped` and `failures` arrays and the subshell exits successfully. This
   explicitly covers tasks in `DEACTIVATING`, `STOPPING`, and `DEPROVISIONING`;
   an old binary must not read the removed queue index, doorbell, or
   deployment-readiness table.
5. From the reviewed retirement-release checkout, confirm the production AWS
   identity and delete the now-unused worker image repository as a one-time
   operator action. This permanently deletes every image in the repository:

   ```bash
   AWS_PROFILE=mymemo aws sts get-caller-identity
   AWS_PROFILE=mymemo aws ecr describe-repositories --region us-west-2 \
     --repository-names mymemo-agent-worker
   AWS_PROFILE=mymemo aws ecr list-images --region us-west-2 \
     --repository-name mymemo-agent-worker --output json
   AWS_PROFILE=mymemo aws ecr delete-repository --region us-west-2 \
     --repository-name mymemo-agent-worker --force
   ```

   Re-run `describe-repositories` and require the specific
   `RepositoryNotFoundException` response; another error is not proof of
   deletion. Do not run the pre-retirement ECR Terraform after deletion because
   that checkout still declares the worker repository. The recurring release
   role intentionally has no repository-deletion authority.

## Apply the retirement release

Run the ordinary reviewed release. Its compatible migration drops the retired
doorbell triggers/function, queue-Claim index, and execution-runtime deployment
table. Terraform reconciles the manually deleted repository out of ECR state,
removes the worker task/service, IAM, secrets, and alarms, and runs
`agent-maintenance` with desired count one.

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
