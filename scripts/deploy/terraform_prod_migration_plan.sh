#!/usr/bin/env bash
set -euo pipefail

tfvars_file="${TFVARS_FILE:-infra/terraform/prod.tfvars}"
generated_tfvars_file="${GENERATED_TFVARS_FILE:-infra/terraform/generated.auto.tfvars}"
plan_file="${1:-agent-migration.tfplan}"

tfvars_file_abs="$(cd "$(dirname "${tfvars_file}")" && pwd -P)/$(basename "${tfvars_file}")"
generated_tfvars_file_abs="$(cd "$(dirname "${generated_tfvars_file}")" && pwd -P)/$(basename "${generated_tfvars_file}")"

terraform -chdir=infra/terraform plan \
  -var-file="${tfvars_file_abs}" \
  -var-file="${generated_tfvars_file_abs}" \
  -target=aws_ecs_task_definition.agent_migration \
  -target=aws_ecs_task_definition.chat_api \
  -out="${plan_file}"
