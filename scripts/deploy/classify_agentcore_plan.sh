#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:-agentcore.tfplan}"
plan_json="$(mktemp /tmp/mymemo-agentcore-plan.XXXXXX.json)"
trap 'rm -f "${plan_json}"' EXIT

terraform -chdir=infra/agentcore show -json "${plan_file}" >"${plan_json}"
bun run scripts/deploy/classify_agentcore_plan.ts \
  "${plan_json}" \
  infra/agentcore/.terraform.lock.hcl
