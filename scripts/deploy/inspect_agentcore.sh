#!/usr/bin/env bash
set -euo pipefail
region="${AWS_REGION:?AWS_REGION is required}"
expected_digest="${EXPECTED_RUNTIME_IMAGE_DIGEST:?EXPECTED_RUNTIME_IMAGE_DIGEST is required}"
source scripts/deploy/agentcore_aws_checks.sh
tf_output="$(terraform -chdir=infra/terraform output -json)"
verify_agentcore_egress "${region}" "${tf_output}"
verify_agentcore_current_secrets "${region}" "${tf_output}"
verify_agentcore_runtime_configuration "${region}" "${tf_output}" "${expected_digest}"
