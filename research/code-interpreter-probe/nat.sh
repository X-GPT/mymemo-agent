#!/usr/bin/env bash
# #730 Q4 — can a task in the PROD AgentCore private subnets (fck-nat egress, Runtime SG) reach the
# public bedrock-agentcore data-plane endpoint? Runs one Fargate task (no logs; the verdict is the
# exit code: curl encodes HTTP class → exit 4 = 4xx = reachable; 6 = DNS fail; 7 = connect fail; 28 = timeout).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-mymemo}" AWS_REGION=us-west-2 AWS_PAGER=""
CLUSTER=mymemo-staging-cluster
SUBNETS='"subnet-03557511022b8c37a","subnet-06e2c26443e720f72"'   # mymemo-agent-agentcore-prod-private-*
SG=sg-04c0023efac1b0380                                          # mymemo-agent-agentcore-prod-runtime
URL=https://bedrock-agentcore.us-west-2.amazonaws.com/
CMD="code=\$(curl -sS -m 20 -o /dev/null -w '%{http_code}' $URL) && echo http=\$code && exit \$((code / 100))"
TD=$(aws ecs register-task-definition --family mymemo-ci-probe-nat --requires-compatibilities FARGATE --network-mode awsvpc --cpu 256 --memory 512 \
  --runtime-platform cpuArchitecture=X86_64,operatingSystemFamily=LINUX \
  --container-definitions "[{\"name\":\"curl\",\"image\":\"public.ecr.aws/amazonlinux/amazonlinux:2023\",\"essential\":true,\"command\":[\"sh\",\"-c\",$(printf '%s' "$CMD" | jq -Rs .)]}]" \
  --query taskDefinition.taskDefinitionArn --output text)
echo "taskdef $TD"
TASK=$(aws ecs run-task --cluster $CLUSTER --launch-type FARGATE --task-definition "$TD" \
  --network-configuration "{\"awsvpcConfiguration\":{\"subnets\":[$SUBNETS],\"securityGroups\":[\"$SG\"],\"assignPublicIp\":\"DISABLED\"}}" \
  --query 'tasks[0].taskArn' --output text)
echo "task $TASK — waiting for it to stop"
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks "$TASK"
aws ecs describe-tasks --cluster $CLUSTER --tasks "$TASK" --query 'tasks[0].{exit:containers[0].exitCode,reason:containers[0].reason,stopped:stoppedReason,stopCode:stopCode}' --output json
EXIT=$(aws ecs describe-tasks --cluster $CLUSTER --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
aws ecs deregister-task-definition --task-definition "$TD" >/dev/null
case "$EXIT" in 2|3|4|5) echo "Q4 PASS: HTTP ${EXIT}xx from $URL via the prod private subnets + fck-nat";; *) echo "Q4 FAIL: exit=$EXIT (6=DNS, 7=connect, 28=timeout, other=image pull/launch problem)";; esac
