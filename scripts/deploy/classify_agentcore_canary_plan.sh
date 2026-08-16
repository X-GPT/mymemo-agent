#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:-agentcore-canary.tfplan}"
plan_json="$(mktemp /tmp/mymemo-agentcore-plan.XXXXXX.json)"
trap 'rm -f "${plan_json}"' EXIT

terraform -chdir=infra/agentcore-canary show -json "${plan_file}" >"${plan_json}"
bun run scripts/deploy/classify_agentcore_canary_plan.ts \
  "${plan_json}" \
  infra/agentcore-canary/.terraform.lock.hcl
