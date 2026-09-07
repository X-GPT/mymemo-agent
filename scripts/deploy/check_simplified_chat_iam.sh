#!/usr/bin/env bash
# Read-only effective-policy checks for #749; no stack resources need to exist.
set -euo pipefail
export AWS_PAGER=""
role=mymemo-agent-github-actions-deploy
account=637423444544
region=us-west-2
arn="arn:aws:iam::$account:role/$role"
[[ $(aws --profile mymemo sts get-caller-identity --query Account --output text) == "$account" ]]

check() {
  local resource=$1 result
  shift
  result=$(aws --profile mymemo iam simulate-principal-policy \
    --policy-source-arn "$arn" --resource-arns "$resource" --action-names "$@" --output json)
  if ! jq -e --argjson count "$#" \
    '.EvaluationResults | length == $count and all(.[]; .EvalDecision == "allowed" and (.MissingContextValues | length) == 0)' \
    <<< "$result" >/dev/null; then
    printf '%s\n' "$result" >&2
    return 1
  fi
  printf 'Allowed: %s on %s\n' "$*" "$resource"
}

printf 'Bootstrap IAM #749 verification — %s\nRole: %s\n' "$(date -u +%FT%TZ)" "$arn"
check "arn:aws:dynamodb:$region:$account:table/mymemo-agent-prod-conversations" \
  dynamodb:CreateTable dynamodb:DescribeTable dynamodb:UpdateTable dynamodb:DeleteTable \
  dynamodb:DescribeContinuousBackups dynamodb:UpdateContinuousBackups \
  dynamodb:DescribeTimeToLive dynamodb:UpdateTimeToLive dynamodb:ListTagsOfResource dynamodb:TagResource dynamodb:UntagResource
check "arn:aws:lambda:$region:$account:function:mymemo-agent-prod-front" \
  lambda:CreateFunction lambda:DeleteFunction lambda:GetFunction lambda:GetFunctionCodeSigningConfig \
  lambda:GetFunctionConcurrency lambda:GetFunctionConfiguration lambda:ListTags lambda:ListVersionsByFunction \
  lambda:TagResource lambda:UntagResource lambda:UpdateFunctionCode lambda:UpdateFunctionConfiguration \
  lambda:CreateFunctionUrlConfig lambda:GetFunctionUrlConfig lambda:UpdateFunctionUrlConfig lambda:DeleteFunctionUrlConfig \
  lambda:AddPermission lambda:RemovePermission lambda:GetPolicy
check '*' bedrock-agentcore:CreateCodeInterpreter
check "arn:aws:bedrock-agentcore:$region:$account:code-interpreter-custom/mymemo_agent_prod-0123456789" \
  bedrock-agentcore:GetCodeInterpreter bedrock-agentcore:DeleteCodeInterpreter \
  bedrock-agentcore:ListTagsForResource bedrock-agentcore:TagResource bedrock-agentcore:UntagResource
check "arn:aws:scheduler:$region:$account:schedule/default/mymemo-agent-prod-sweep" \
  scheduler:CreateSchedule scheduler:GetSchedule scheduler:UpdateSchedule scheduler:DeleteSchedule
check 'arn:aws:s3:::mymemo-agent-prod-workspace' \
  s3:CreateBucket s3:DeleteBucket s3:DeleteBucketPolicy s3:GetAccelerateConfiguration \
  s3:GetBucketAcl s3:GetBucketCORS s3:GetBucketLocation s3:GetBucketLogging s3:GetBucketObjectLockConfiguration \
  s3:GetBucketOwnershipControls s3:GetBucketPolicy s3:GetBucketPublicAccessBlock s3:GetBucketRequestPayment \
  s3:GetBucketTagging s3:GetBucketVersioning s3:GetBucketWebsite s3:GetEncryptionConfiguration \
  s3:GetLifecycleConfiguration s3:GetReplicationConfiguration s3:ListBucket s3:PutBucketOwnershipControls \
  s3:PutBucketPolicy s3:PutBucketPublicAccessBlock s3:PutBucketTagging s3:PutBucketVersioning \
  s3:PutEncryptionConfiguration s3:PutLifecycleConfiguration
# Existing grants used by the front, sweep execution role and new Runtime.
for name in mymemo-agent-prod-front mymemo-agent-prod-sweep; do
  check "arn:aws:iam::$account:role/$name" \
    iam:CreateRole iam:GetRole iam:DeleteRole iam:UpdateAssumeRolePolicy iam:PutRolePolicy \
    iam:GetRolePolicy iam:DeleteRolePolicy iam:ListRolePolicies iam:ListAttachedRolePolicies \
    iam:AttachRolePolicy iam:DetachRolePolicy iam:TagRole iam:UntagRole iam:PassRole
done
check "arn:aws:logs:$region:$account:log-group:/aws/lambda/mymemo-agent-prod-front:*" \
  logs:CreateLogGroup logs:ListTagsForResource logs:TagResource logs:PutRetentionPolicy logs:DeleteLogGroup
check '*' logs:DescribeLogGroups
check '*' bedrock-agentcore:CreateAgentRuntime bedrock-agentcore:CreateAgentRuntimeEndpoint \
  bedrock-agentcore:GetAgentRuntime bedrock-agentcore:GetAgentRuntimeEndpoint bedrock-agentcore:UpdateAgentRuntime \
  bedrock-agentcore:DeleteAgentRuntime bedrock-agentcore:ListAgentRuntimeVersions bedrock-agentcore:CreateWorkloadIdentity

printf '\nAttached managed policy versions:\n'
policies=$(aws --profile mymemo iam list-attached-role-policies --role-name "$role" --output json)
while IFS= read -r policy; do
  aws --profile mymemo iam get-policy --policy-arn "$policy" \
    --query 'Policy.{Arn:Arn,DefaultVersionId:DefaultVersionId,UpdateDate:UpdateDate}' --output json
done < <(jq -r '.AttachedPolicies[].PolicyArn' <<< "$policies")
printf '\nInline policies (IAM does not version inline policies):\n'
aws --profile mymemo iam list-role-policies --role-name "$role" --output json
printf '\nAll grant simulations passed. Simulations check IAM authorization, not a live deployment.\n'
