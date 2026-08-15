#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

aws_profile="mymemo"
region="us-west-2"
account_id="637423444544"
repository="X-GPT/mymemo-agent"
confirmation="${1:-}"

if [[ "${confirmation}" != "bootstrap-mymemo-agentcore-canary-prod" ]]; then
  echo "Usage: $0 bootstrap-mymemo-agentcore-canary-prod" >&2
  exit 1
fi

if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "Run the canary bootstrap from the reviewed main branch." >&2
  exit 1
fi
if [[ -n "$(git status --short)" ]]; then
  echo "Run the canary bootstrap from a clean worktree." >&2
  exit 1
fi
git fetch origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main must match origin/main before canary bootstrap." >&2
  exit 1
fi

caller_account="$(aws --profile "${aws_profile}" sts get-caller-identity --query Account --output text)"
if [[ "${caller_account}" != "${account_id}" ]]; then
  echo "The mymemo profile must target AWS account ${account_id}." >&2
  exit 1
fi

github_variable() {
  gh variable get "$1" --repo "${repository}"
}

export AWS_PROFILE="${aws_profile}"
export TF_INPUT=false
export TF_IN_AUTOMATION=true
export TF_VAR_aws_region="${region}"
export TF_VAR_aws_account_id="${account_id}"
export TF_VAR_runtime_image_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"
export TF_VAR_dispatch_lambda_package="${repo_root}/dist/agentcore-canary-lambdas/dispatch.zip"
export TF_VAR_control_lambda_package="${repo_root}/dist/agentcore-canary-lambdas/control.zip"
export TF_VAR_agent_database_url_secret_arn="$(github_variable AGENTCORE_CANARY_AGENT_DATABASE_URL_SECRET_ARN)"
export TF_VAR_kb_database_url_secret_arn="$(github_variable AGENTCORE_CANARY_KB_DATABASE_URL_SECRET_ARN)"
export TF_VAR_openrouter_api_key_secret_arn="$(github_variable AGENTCORE_CANARY_OPENROUTER_API_KEY_SECRET_ARN)"
export TF_VAR_e2b_api_key_secret_arn="$(github_variable AGENTCORE_CANARY_E2B_API_KEY_SECRET_ARN)"
export TF_VAR_redis_url_secret_arn="$(github_variable AGENTCORE_CANARY_REDIS_URL_SECRET_ARN)"
export TF_VAR_artifact_bucket_name="mymemo-agent-prod-artifacts"
export TF_VAR_openrouter_default_model="$(github_variable AGENTCORE_CANARY_OPENROUTER_DEFAULT_MODEL)"
export TF_VAR_canary_control_config_json="$(github_variable AGENTCORE_CANARY_CONTROL_CONFIG_JSON)"
export TF_VAR_canary_approved_synthetic_user_id="$(github_variable AGENTCORE_CANARY_SYNTHETIC_USER_ID)"
export TF_VAR_incident_alarm_action_arns="$(github_variable AGENTCORE_CANARY_INCIDENT_ALARM_ARNS_JSON)"
export TF_VAR_validation_alarm_action_arns="$(github_variable AGENTCORE_CANARY_VALIDATION_ALARM_ARNS_JSON)"
export TF_VAR_campaign_network_enabled=false
export TF_VAR_dispatch_enabled=false

ca_bundle="$(mktemp /tmp/mymemo-agentcore-bootstrap-ca.XXXXXX)"
trap 'rm -f "${ca_bundle}"' EXIT
curl --fail --silent --show-error --location \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  --output "${ca_bundle}"
if command -v sha256sum >/dev/null; then
  echo "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  ${ca_bundle}" | sha256sum --check
else
  echo "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  ${ca_bundle}" | shasum -a 256 --check
fi

bun install --frozen-lockfile
scripts/deploy/build_agentcore_canary_lambdas.sh \
  dist/agentcore-canary-lambdas \
  "${ca_bundle}"

terraform -chdir=infra/agentcore-canary init
terraform -chdir=infra/agentcore-canary plan \
  -target=aws_ecr_repository.runtime \
  -target=aws_iam_role.deployment \
  -target=aws_iam_role_policy.deployment \
  -target=aws_cloudwatch_event_rule.repair \
  -out=agentcore-canary-bootstrap.tfplan
scripts/deploy/classify_agentcore_canary_plan.sh agentcore-canary-bootstrap.tfplan
terraform -chdir=infra/agentcore-canary apply \
  -auto-approve \
  agentcore-canary-bootstrap.tfplan
