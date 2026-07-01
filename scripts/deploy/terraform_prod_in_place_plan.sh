#!/usr/bin/env bash
set -euo pipefail

tfvars_file="${TFVARS_FILE:-infra/terraform/prod.tfvars}"
generated_tfvars_file="${GENERATED_TFVARS_FILE:-infra/terraform/generated.auto.tfvars}"
plan_file="${1:-agent-prod.tfplan}"

if [[ ! -f "$tfvars_file" ]]; then
  echo "Missing Terraform var file: $tfvars_file" >&2
  exit 1
fi

if [[ ! -f "$generated_tfvars_file" ]]; then
  echo "Missing generated image var file: $generated_tfvars_file; run scripts/deploy/ci_prepare_tfvars.sh first" >&2
  exit 1
fi

if grep -q 'REPLACE_ME\|TODO' "$tfvars_file" "$generated_tfvars_file"; then
  echo "Terraform var files contain placeholders; update $tfvars_file and rerun generated tfvars preparation." >&2
  exit 1
fi

tfvars_file_abs="$(cd "$(dirname "$tfvars_file")" && pwd -P)/$(basename "$tfvars_file")"
generated_tfvars_file_abs="$(cd "$(dirname "$generated_tfvars_file")" && pwd -P)/$(basename "$generated_tfvars_file")"

terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -var-file="$tfvars_file_abs" -var-file="$generated_tfvars_file_abs" -out="$plan_file"
