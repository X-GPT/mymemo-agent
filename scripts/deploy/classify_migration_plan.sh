#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:-agent-migration.tfplan}"
unexpected_changes="$({
  terraform -chdir=infra/terraform show -json "${plan_file}" |
    jq -r '
      .resource_changes[]?
      | select(.mode == "managed")
      | select((.change.actions - ["no-op", "read"]) != [])
      | select(.address != "aws_ecs_task_definition.agent_migration")
      | .address
    '
} || exit 1)"

if [[ -n "${unexpected_changes}" ]]; then
  echo "The migration-only plan includes unexpected managed changes:" >&2
  sed 's/^/  /' <<<"${unexpected_changes}" >&2
  exit 1
fi

echo "migration-only"
