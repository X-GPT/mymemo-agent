#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/deploy/create_bootstrap_kb_database_secret.sh

Creates or updates the temporary KB_DATABASE_URL secret used by agent-worker.
This is option-2 bootstrap wiring: it reuses the existing mymemo-service DB
role/password and should be replaced by a read-only KB role.

Required/optional env:
  AWS_PROFILE                 default: mymemo
  AWS_REGION                  default: us-west-2
  KB_SECRET_NAME              default: mymemo-agent-prod-KB_DATABASE_URL
  MYMEMO_SERVICE_DB_ID        default: mymemo-staging-pg
  MYMEMO_SERVICE_DB_NAME      default: mymemo
  MYMEMO_SERVICE_DB_USER      default: mymemo
  MYMEMO_SERVICE_PASSWORD_SECRET_ID
    default: mymemo-staging-db-password-20260503021510360100000001
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

profile="${AWS_PROFILE:-mymemo}"
region="${AWS_REGION:-us-west-2}"
secret_name="${KB_SECRET_NAME:-mymemo-agent-prod-KB_DATABASE_URL}"
db_id="${MYMEMO_SERVICE_DB_ID:-mymemo-staging-pg}"
db_name="${MYMEMO_SERVICE_DB_NAME:-mymemo}"
db_user="${MYMEMO_SERVICE_DB_USER:-mymemo}"
password_secret_id="${MYMEMO_SERVICE_PASSWORD_SECRET_ID:-mymemo-staging-db-password-20260503021510360100000001}"

endpoint="$(
  aws rds describe-db-instances \
    --profile "$profile" \
    --region "$region" \
    --db-instance-identifier "$db_id" \
    --query 'DBInstances[0].Endpoint.Address' \
    --output text
)"

port="$(
  aws rds describe-db-instances \
    --profile "$profile" \
    --region "$region" \
    --db-instance-identifier "$db_id" \
    --query 'DBInstances[0].Endpoint.Port' \
    --output text
)"

password="$(
  aws secretsmanager get-secret-value \
    --profile "$profile" \
    --region "$region" \
    --secret-id "$password_secret_id" \
    --query SecretString \
    --output text
)"

encoded_password="$(
  PASSWORD="$password" bun -e 'console.log(encodeURIComponent(Bun.env.PASSWORD ?? ""))'
)"

database_url="postgresql://${db_user}:${encoded_password}@${endpoint}:${port}/${db_name}"

if aws secretsmanager describe-secret \
  --profile "$profile" \
  --region "$region" \
  --secret-id "$secret_name" \
  >/dev/null 2>&1; then
  aws secretsmanager update-secret \
    --profile "$profile" \
    --region "$region" \
    --secret-id "$secret_name" \
    --secret-string "$database_url" \
    >/dev/null
else
  aws secretsmanager create-secret \
    --profile "$profile" \
    --region "$region" \
    --name "$secret_name" \
    --description "TEMPORARY bootstrap KB_DATABASE_URL for mymemo-agent; replace with read-only KB role" \
    --secret-string "$database_url" \
    >/dev/null
fi

echo "KB_DATABASE_URL secret is ready:"
echo "$secret_name"
