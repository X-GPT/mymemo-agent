#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/deploy/create_agent_secrets.sh

Creates or updates mymemo-agent AWS Secrets Manager entries using the same
conventional names Terraform resolves at plan/apply time.

Inputs:
  DEPLOY_CONFIG          default: infra/deploy/prod.env
  DEPLOY_SECRETS_CONFIG  default: infra/deploy/<DEPLOY_ENVIRONMENT>.secrets.env
  AWS_PROFILE            optional; used for local AWS CLI auth
  AWS_REGION             loaded from DEPLOY_CONFIG unless already set
  NAME_PREFIX            default: mymemo-agent; must match Terraform name_prefix

Secret value inputs, from DEPLOY_SECRETS_CONFIG or environment:
  LLM_TOKEN_SECRET_VALUE
  STATSIG_SERVER_SECRET_VALUE
  OPENROUTER_API_KEY_VALUE
  E2B_API_KEY_VALUE
  KB_DATABASE_URL_VALUE       optional

DEPLOY_SECRETS_CONFIG uses simple KEY=value dotenv lines. It is parsed as data,
not sourced as shell, so do not use shell interpolation or command substitution.
This script never prints secret values.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

environment="${DEPLOY_ENVIRONMENT:-prod}"
secrets_config="${DEPLOY_SECRETS_CONFIG:-infra/deploy/${environment}.secrets.env}"

load_dotenv_file() {
  local file="$1"
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export }"
    fi

    if [[ "$line" != *=* ]]; then
      echo "Invalid line in $file: expected KEY=value" >&2
      exit 1
    fi

    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Invalid variable name in $file: $key" >&2
      exit 1
    fi

    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    printf -v "$key" '%s' "$value"
  done <"$file"
}

if [[ -f "$secrets_config" ]]; then
  load_dotenv_file "$secrets_config"
fi

: "${AWS_REGION:?AWS_REGION is required in $DEPLOY_CONFIG_PATH or env}"

aws_args=(--region "$AWS_REGION")
if [[ -n "${AWS_PROFILE:-}" ]]; then
  aws_args+=(--profile "$AWS_PROFILE")
fi

require_secret_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required; set it in $secrets_config or the job environment" >&2
    exit 1
  fi
}

upsert_secret() {
  local secret_name="$1"
  local secret_value="$2"
  local description="$3"

  if aws secretsmanager describe-secret "${aws_args[@]}" --secret-id "$secret_name" >/dev/null 2>&1; then
    aws secretsmanager update-secret \
      "${aws_args[@]}" \
      --secret-id "$secret_name" \
      --secret-string "$secret_value" \
      >/dev/null
  else
    aws secretsmanager create-secret \
      "${aws_args[@]}" \
      --name "$secret_name" \
      --description "$description" \
      --secret-string "$secret_value" \
      >/dev/null
  fi

  echo "$secret_name"
}

require_secret_value LLM_TOKEN_SECRET_VALUE
require_secret_value STATSIG_SERVER_SECRET_VALUE
require_secret_value OPENROUTER_API_KEY_VALUE
require_secret_value E2B_API_KEY_VALUE

name_prefix="${NAME_PREFIX:-mymemo-agent}"
prefix="${name_prefix}-${environment}"

llm_token_secret_name="$(
  upsert_secret "${prefix}-LLM_TOKEN_SECRET" \
    "$LLM_TOKEN_SECRET_VALUE" \
    "LLM token HMAC secret for mymemo-agent ${environment}"
)"

statsig_server_secret_name="$(
  upsert_secret "${prefix}-STATSIG_SERVER_SECRET" \
    "$STATSIG_SERVER_SECRET_VALUE" \
    "Statsig server secret for mymemo-agent ${environment}"
)"

openrouter_api_key_secret_name="$(
  upsert_secret "${prefix}-OPENROUTER_API_KEY" \
    "$OPENROUTER_API_KEY_VALUE" \
    "OpenRouter API key for mymemo-agent ${environment}"
)"

e2b_api_key_secret_name="$(
  upsert_secret "${prefix}-E2B_API_KEY" \
    "$E2B_API_KEY_VALUE" \
    "E2B API key for mymemo-agent ${environment}"
)"

kb_database_url_secret_name="${prefix}-KB_DATABASE_URL"
if [[ -n "${KB_DATABASE_URL_VALUE:-}" ]]; then
  kb_database_url_secret_name="$(
    upsert_secret "${prefix}-KB_DATABASE_URL" \
      "$KB_DATABASE_URL_VALUE" \
      "KB database URL for mymemo-agent ${environment}"
  )"
fi

echo "Agent Secrets Manager entries are ready."
echo "Terraform will resolve these names:"
echo "  LLM_TOKEN_SECRET: ${llm_token_secret_name}"
echo "  STATSIG_SERVER_SECRET: ${statsig_server_secret_name}"
echo "  OPENROUTER_API_KEY: ${openrouter_api_key_secret_name}"
echo "  E2B_API_KEY: ${e2b_api_key_secret_name}"
echo "  KB_DATABASE_URL: ${kb_database_url_secret_name}"
