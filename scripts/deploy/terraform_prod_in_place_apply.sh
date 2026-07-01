#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:-agent-prod.tfplan}"

if [[ "${CONFIRM_AGENT_PROD_APPLY:-}" != "apply-mymemo-agent-prod" ]]; then
  echo "Refusing to apply. Set CONFIRM_AGENT_PROD_APPLY=apply-mymemo-agent-prod." >&2
  exit 1
fi

terraform -chdir=infra/terraform apply "$plan_file"
