#!/usr/bin/env bash
set -euo pipefail
out="${1:-infra/terraform/generated.auto.tfvars}"
: "${AWS_REGION:?AWS_REGION is required}"
[[ "${AWS_REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]
mkdir -p "$(dirname "$out")"
printf 'aws_region = "%s"\n' "$AWS_REGION" > "$out"
