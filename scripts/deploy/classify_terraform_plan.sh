#!/usr/bin/env bash
set -euo pipefail

# Classify a saved Terraform plan into a release lane:
#   app   - every change is the routine image-tag roll (task definitions and
#           the ECS services that point at them); safe to apply unattended.
#   infra - anything else changes; the deploy requires a manual
#           workflow_dispatch with the typed confirm phrase.
# Prints the lane on stdout; diagnostics go to stderr.

plan_file="${1:-agent-prod.tfplan}"

non_app_types="$(
  terraform -chdir=infra/terraform show -json "$plan_file" \
    | jq -r '
        [.resource_changes[]?
          | select((.change.actions - ["no-op", "read"]) != [])
          | .type
          | select(. != "aws_ecs_task_definition" and . != "aws_ecs_service")]
        | unique | .[]'
)"

if [[ -z "$non_app_types" ]]; then
  echo "app"
else
  echo "Plan changes non-app resource types:" >&2
  sed 's/^/  /' <<<"$non_app_types" >&2
  echo "infra"
fi
