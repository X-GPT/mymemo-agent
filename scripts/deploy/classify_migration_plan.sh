#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:-agent-migration.tfplan}"
plan_text="$(terraform -chdir=infra/terraform show -no-color "${plan_file}")"
unexpected_changes="$(
  awk '
    /^  # / {
      change = $0
      sub(/^  # /, "", change)
      if (change ~ / will be read during apply$/) next

      address = change
      sub(/ (will|must) .*/, "", address)
      if (address != "aws_ecs_task_definition.agent_migration") print address
    }
  ' <<<"${plan_text}"
)"

if [[ -n "${unexpected_changes}" ]]; then
  echo "The migration-only plan includes unexpected managed changes:" >&2
  sed 's/^/  /' <<<"${unexpected_changes}" >&2
  exit 1
fi

echo "migration-only"
